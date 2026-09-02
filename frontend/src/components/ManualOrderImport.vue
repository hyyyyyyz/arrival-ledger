<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import type {
  CreateManualOrderInput,
  ManualOrderBatchCreateInput,
  ManualOrderBatchCreateResponse,
  ManualOrderCreateResponse,
} from '@/types'
import { ApiError } from '@/services/api'
import {
  deleteManualOrderDraft,
  getManualOrderDraft,
  putManualOrderDraft,
  type ManualOrderDraft,
} from '@/services/db'
import { createId } from '@/utils/id'
import {
  MANUAL_IMPORT_LIMITS,
  parseManualOrderFile,
  parseTrackingText,
  suspiciousTrackingFormatMessage,
  type ManualImportPreviewRow,
} from '@/utils/manualOrderImport'
import { isPlausibleTrackingNo, normalizeTrackingNo } from '@/utils/tracking'

const props = defineProps<{
  ownerUserId: string
  createManualOrder: (input: CreateManualOrderInput) => Promise<ManualOrderCreateResponse>
  createManualOrderBatch: (input: ManualOrderBatchCreateInput) => Promise<ManualOrderBatchCreateResponse>
}>()

const emit = defineEmits<{ imported: []; authRequired: [] }>()

const singleOrder = ref({ trackingNo: '', productName: '', courier: '', remark: '' })
const singleSaving = ref(false)
const singleMessage = ref('')
const singleMessageIsError = ref(false)
const singleEventId = ref('')
const singleEventPayload = ref('')

const bulkText = ref('')
const bulkDefaults = ref({ productName: '', courier: '', remark: '' })
const bulkRows = ref<ManualImportPreviewRow[]>([])
const bulkFatalError = ref('')
const bulkParsing = ref(false)
const bulkSaving = ref(false)
const bulkBatchId = ref('')
const bulkPayloadKey = ref('')
const bulkResult = ref<ManualOrderBatchCreateResponse | null>(null)
const sourceLabel = ref('')
const bulkSubmitted = ref(false)
const draftLoaded = ref(false)
const draftStorageMessage = ref('')
let draftWriteChain: Promise<void> = Promise.resolve()
let suspendDraftPersistence = false
let draftStorageHealthy = true

const readyRows = computed(() => bulkRows.value.filter((row) => row.state === 'READY'))
const duplicateRows = computed(() => bulkRows.value.filter((row) => row.state === 'DUPLICATE_INPUT').length)
const failedRows = computed(() => bulkRows.value.filter((row) => row.state === 'FAILED').length)
const defaultProductRows = computed(() => readyRows.value.filter((row) => row.usesDefaultProduct).length)
const fileLimitText = `${Math.round(MANUAL_IMPORT_LIMITS.maxFileBytes / 1024)} KiB`

function resetBulkResult(): void {
  bulkRows.value = []
  bulkFatalError.value = ''
  bulkResult.value = null
  sourceLabel.value = ''
  bulkBatchId.value = ''
  bulkPayloadKey.value = ''
  bulkSubmitted.value = false
}

function payloadFingerprint(rows = readyRows.value): string {
  return JSON.stringify(rows.map((row) => [row.sourceRow, row.trackingNo, row.productName, row.courier, row.remark]))
}

function draftSnapshot(): ManualOrderDraft {
  return {
    ownerUserId: props.ownerUserId,
    bulkText: bulkText.value,
    defaults: { ...bulkDefaults.value },
    rows: bulkRows.value.map((row) => ({ ...row })),
    sourceLabel: sourceLabel.value,
    batchId: bulkBatchId.value,
    payloadKey: bulkPayloadKey.value,
    submitted: bulkSubmitted.value,
    updatedAt: Date.now(),
  }
}

function queueDraftSave(): void {
  if (!draftLoaded.value || suspendDraftPersistence) return
  const snapshot = draftSnapshot()
  draftWriteChain = draftWriteChain.catch(() => undefined).then(async () => {
    try {
      const hasContent = Boolean(snapshot.bulkText.trim() || snapshot.rows.length || Object.values(snapshot.defaults).some((value) => value.trim()))
      if (hasContent) await putManualOrderDraft(snapshot)
      else await deleteManualOrderDraft(snapshot.ownerUserId)
      draftStorageHealthy = true
      draftStorageMessage.value = ''
    } catch {
      draftStorageHealthy = false
      draftStorageMessage.value = '无法保存本机草稿；离开页面前请保留原文件或文本。'
    }
  })
}

async function clearDraft(): Promise<void> {
  const deleteOperation = draftWriteChain.catch(() => undefined).then(() => deleteManualOrderDraft(props.ownerUserId))
  draftWriteChain = deleteOperation.catch(() => undefined)
  try { await deleteOperation } catch {
    draftStorageHealthy = false
    draftStorageMessage.value = '导入已完成，但本机草稿清理失败；再次看到旧草稿时请勿重复提交。'
  }
}

onMounted(async () => {
  try {
    const draft = await getManualOrderDraft(props.ownerUserId)
    if (draft) {
      bulkText.value = draft.bulkText
      bulkDefaults.value = { ...draft.defaults }
      bulkRows.value = draft.rows.map((row) => ({ ...row }))
      sourceLabel.value = draft.sourceLabel
      bulkBatchId.value = draft.batchId
      bulkPayloadKey.value = draft.payloadKey
      bulkSubmitted.value = draft.submitted === true
      if (bulkSubmitted.value) bulkFatalError.value = '该批已提交，为避免重复操作不可再次提交；请修改内容后重新预览。'
    }
  } catch {
    draftStorageHealthy = false
    draftStorageMessage.value = '无法读取本机草稿，本次修改可能不会自动保存。'
  } finally {
    draftLoaded.value = true
  }
})

watch([bulkText, bulkDefaults, bulkRows, sourceLabel, bulkBatchId, bulkPayloadKey], queueDraftSave, { deep: true })

function applyPreview(rows: ManualImportPreviewRow[], fatalError: string, label: string): void {
  bulkRows.value = rows
  bulkFatalError.value = fatalError
  bulkResult.value = null
  sourceLabel.value = fatalError ? '' : label
  bulkPayloadKey.value = fatalError ? '' : payloadFingerprint(rows.filter((row) => row.state === 'READY'))
  bulkBatchId.value = fatalError ? '' : createId()
  bulkSubmitted.value = false
}

async function createSingleOrder(): Promise<void> {
  if (singleSaving.value) return
  singleMessage.value = ''
  singleMessageIsError.value = false
  const rawTrackingNo = singleOrder.value.trackingNo.trim()
  const suspiciousMessage = suspiciousTrackingFormatMessage(rawTrackingNo)
  if (suspiciousMessage) {
    singleMessage.value = suspiciousMessage
    singleMessageIsError.value = true
    return
  }
  const trackingNo = normalizeTrackingNo(rawTrackingNo)
  const productName = singleOrder.value.productName.trim()
  if (!isPlausibleTrackingNo(trackingNo)) {
    singleMessage.value = '请检查运单号，通常应为 8–32 位且至少包含一个数字'
    singleMessageIsError.value = true
    return
  }
  if (!productName) {
    singleMessage.value = '请填写商品名称'
    singleMessageIsError.value = true
    return
  }
  const normalizedOrder = {
    trackingNo,
    productName,
    courier: singleOrder.value.courier.trim(),
    remark: singleOrder.value.remark.trim(),
  }
  const eventPayload = JSON.stringify(normalizedOrder)
  if (singleEventPayload.value !== eventPayload) {
    singleEventPayload.value = eventPayload
    singleEventId.value = createId()
  }
  singleSaving.value = true
  try {
    await props.createManualOrder({
      client_event_id: singleEventId.value,
      tracking_no: normalizedOrder.trackingNo,
      product_name: normalizedOrder.productName,
      courier: normalizedOrder.courier || undefined,
      remark: normalizedOrder.remark || undefined,
    })
    singleMessage.value = '第三方订单已加入订单列表'
    singleOrder.value = { trackingNo: '', productName: '', courier: '', remark: '' }
    singleEventId.value = ''
    singleEventPayload.value = ''
    emit('imported')
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) emit('authRequired')
    singleMessage.value = error instanceof ApiError && error.status === 0 ? '网络不可用，请联网后重试' : error instanceof Error ? error.message : '录入失败，请重试'
    singleMessageIsError.value = true
  } finally {
    singleSaving.value = false
  }
}

function previewText(): void {
  const preview = parseTrackingText(bulkText.value, bulkDefaults.value)
  applyPreview(preview.rows, preview.fatalError, '粘贴内容')
}

async function handleImportFile(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file || bulkParsing.value || bulkSaving.value) return
  resetBulkResult()
  bulkParsing.value = true
  try {
    const preview = await parseManualOrderFile(file, bulkDefaults.value)
    applyPreview(preview.rows, preview.fatalError, file.name)
  } finally {
    bulkParsing.value = false
  }
}

function batchPayload(): ManualOrderBatchCreateInput {
  return {
    client_batch_id: bulkBatchId.value,
    rows: readyRows.value.map((row) => ({
      row_number: row.sourceRow,
      tracking_no: row.trackingNo,
      product_name: row.productName || undefined,
      courier: row.courier || undefined,
      remark: row.remark || undefined,
    })),
  }
}

async function confirmBulkImport(): Promise<void> {
  if (bulkSaving.value || bulkSubmitted.value || readyRows.value.length === 0) return
  bulkFatalError.value = ''
  const payloadKey = payloadFingerprint()
  if (bulkPayloadKey.value !== payloadKey) {
    bulkPayloadKey.value = payloadKey
    bulkBatchId.value = createId()
  }
  const payload = batchPayload()
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MANUAL_IMPORT_LIMITS.maxPayloadBytes) {
    bulkFatalError.value = '导入内容超过服务器单批上限，请减少条数或缩短备注后重试。'
    return
  }
  bulkSaving.value = true
  try {
    bulkResult.value = await props.createManualOrderBatch(payload)
    bulkSubmitted.value = true
    queueDraftSave()
    await draftWriteChain
    if (bulkResult.value.created_count > 0 || bulkResult.value.idempotent_count > 0) emit('imported')
    if (bulkResult.value.failed_count === 0) {
      suspendDraftPersistence = true
      bulkText.value = ''
      bulkDefaults.value = { productName: '', courier: '', remark: '' }
      bulkRows.value = []
      sourceLabel.value = ''
      bulkBatchId.value = ''
      bulkPayloadKey.value = ''
      await clearDraft()
      suspendDraftPersistence = false
    }
  } catch (error) {
    await draftWriteChain
    if (error instanceof ApiError && error.status === 401) {
      emit('authRequired')
      bulkFatalError.value = draftStorageHealthy ? '登录已过期，请重新登录；批量草稿已保存在本机。' : '登录已过期，请重新登录；本机草稿未能保存，请保留原文件或文本。'
    } else if (error instanceof ApiError && error.status === 0) {
      bulkFatalError.value = draftStorageHealthy ? '网络不可用，批量草稿已保存在本机；联网后可重试。' : '网络不可用，且本机草稿未能保存；请保留原文件或文本后再重试。'
    } else bulkFatalError.value = error instanceof Error ? error.message : '批量导入失败，请重试'
  } finally {
    bulkSaving.value = false
  }
}
</script>

<template>
  <details class="manual-order-panel">
    <summary>其他渠道快递（手动录入）</summary>

    <section class="manual-entry-section" aria-labelledby="single-manual-order-title">
      <div class="manual-entry-heading">
        <h3 id="single-manual-order-title">单条录入</h3>
        <small>适合临时补一单</small>
      </div>
      <form class="manual-order-form" @submit.prevent="createSingleOrder">
        <label><span>运单号</span><input v-model="singleOrder.trackingNo" required inputmode="text" autocapitalize="characters" autocomplete="off" placeholder="请输入运单号" :disabled="!draftLoaded || singleSaving" /></label>
        <label><span>商品名称</span><input v-model="singleOrder.productName" required maxlength="256" placeholder="请输入商品名称" :disabled="!draftLoaded || singleSaving" /></label>
        <label><span>物流公司（可选）</span><input v-model="singleOrder.courier" maxlength="128" placeholder="例如：邮政 EMS" :disabled="!draftLoaded || singleSaving" /></label>
        <label><span>备注（可选）</span><input v-model="singleOrder.remark" maxlength="512" placeholder="例如：甲方临时交办" :disabled="!draftLoaded || singleSaving" /></label>
        <button type="submit" :disabled="!draftLoaded || singleSaving">{{ !draftLoaded ? '正在读取本机草稿…' : singleSaving ? '保存中…' : '加入订单' }}</button>
      </form>
      <p v-if="singleMessage" class="manual-order-message" :class="{ error: singleMessageIsError }" :role="singleMessageIsError ? 'alert' : 'status'">{{ singleMessage }}</p>
    </section>

    <section class="manual-entry-section bulk-import-section" aria-labelledby="bulk-manual-order-title">
      <div class="manual-entry-heading">
        <h3 id="bulk-manual-order-title">批量导入</h3>
        <small>最多 {{ MANUAL_IMPORT_LIMITS.maxRows }} 条</small>
      </div>

      <label class="manual-field">
        <span>统一商品名称（可选）</span>
        <input v-model="bulkDefaults.productName" maxlength="256" :disabled="!draftLoaded || bulkParsing || bulkSaving" placeholder="留空时显示“未填写商品名称”" @input="resetBulkResult" />
      </label>
      <div class="manual-optional-grid">
        <label class="manual-field"><span>统一物流公司（可选）</span><input v-model="bulkDefaults.courier" maxlength="128" :disabled="!draftLoaded || bulkParsing || bulkSaving" placeholder="例如：中通快递" @input="resetBulkResult" /></label>
        <label class="manual-field"><span>统一备注（可选）</span><input v-model="bulkDefaults.remark" maxlength="512" :disabled="!draftLoaded || bulkParsing || bulkSaving" placeholder="整批订单备注" @input="resetBulkResult" /></label>
      </div>

      <label class="manual-field">
        <span>粘贴运单号</span>
        <textarea v-model="bulkText" rows="5" :maxlength="MANUAL_IMPORT_LIMITS.maxTextCharacters" :disabled="!draftLoaded || bulkParsing || bulkSaving" placeholder="每行一个，也可用逗号、中文逗号或分号分隔" @input="resetBulkResult"></textarea>
      </label>
      <button class="secondary-import-button" type="button" :disabled="!draftLoaded || bulkParsing || bulkSaving || !bulkText.trim()" @click="previewText">预览粘贴内容</button>

      <div class="manual-divider" role="separator"><span>或者上传表格</span></div>
      <label class="file-import-button" :class="{ disabled: !draftLoaded || bulkParsing || bulkSaving }">
        <input class="visually-hidden" type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :disabled="!draftLoaded || bulkParsing || bulkSaving" @change="handleImportFile" />
        <strong>{{ bulkParsing ? '正在解析表格…' : '选择 Excel / CSV 文件' }}</strong>
        <small>物流列仅支持“运单号 / 物流单号 / 快递单号 / 快递号”；商品列支持“商品名称 / 商品 / 品名”；文件不超过 {{ fileLimitText }}</small>
      </label>
      <p class="manual-file-hint">支持 .xlsx、.csv；旧版 .xls 请先另存为 .xlsx 或 CSV。</p>
      <p v-if="draftStorageMessage" class="manual-import-alert" role="alert">{{ draftStorageMessage }}</p>

      <p v-if="bulkFatalError" class="manual-import-alert" role="alert">{{ bulkFatalError }}</p>

      <section v-if="bulkRows.length" class="manual-import-preview" aria-labelledby="manual-preview-title">
        <div class="manual-preview-heading">
          <div><h4 id="manual-preview-title">导入预览</h4><small>{{ sourceLabel }}</small></div>
          <span>{{ readyRows.length }} 条可导入</span>
        </div>
        <p class="manual-preview-summary">
          已去重 {{ duplicateRows }} 条，错误 {{ failedRows }} 条
          <template v-if="defaultProductRows">，{{ defaultProductRows }} 条将使用默认商品名</template>
        </p>
        <ul class="manual-preview-list" aria-label="待导入订单预览">
          <li v-for="row in bulkRows" :key="`${row.sourceRow}-${row.trackingNo}`" :class="`state-${row.state.toLowerCase()}`">
            <div><strong>{{ row.trackingNo || `第 ${row.sourceRow} 行` }}</strong><span>{{ row.state === 'READY' ? '可导入' : row.state === 'DUPLICATE_INPUT' ? '已去重' : '有错误' }}</span></div>
            <p>{{ row.productName || '未填写商品名称' }}</p>
            <small>第 {{ row.sourceRow }} 行 · {{ row.message }}</small>
          </li>
        </ul>
        <button class="confirm-import-button" type="button" :disabled="!draftLoaded || bulkSaving || bulkSubmitted || readyRows.length === 0" @click="confirmBulkImport">
          {{ bulkSaving ? '正在导入…' : bulkSubmitted ? '本批已提交，请修改内容后重新预览' : `确认导入 ${readyRows.length} 条` }}
        </button>
      </section>

      <section v-if="bulkResult" class="manual-import-result" aria-live="polite">
        <strong>{{ bulkResult.idempotent_replay ? '已确认此前导入结果' : '导入完成' }}</strong>
        <p>新建 {{ bulkResult.created_count }} 条，已存在 {{ bulkResult.idempotent_count }} 条，重复/跳过 {{ bulkResult.duplicate_count + duplicateRows }} 条，失败 {{ bulkResult.failed_count + failedRows }} 条。</p>
        <ul v-if="bulkResult.items.some((item) => item.status === 'FAILED')">
          <li v-for="(item, index) in bulkResult.items.filter((entry) => entry.status === 'FAILED')" :key="`${item.tracking_no}-${index}`">
            {{ item.tracking_no || `第 ${item.row_number || index + 1} 行` }}：{{ item.message || item.error_code || '导入失败' }}
          </li>
        </ul>
      </section>
    </section>
  </details>
</template>
