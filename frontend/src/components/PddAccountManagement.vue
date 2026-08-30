<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { ApiError, createPlatformAccount, listPlatformAccounts } from '@/services/api'
import type { CreatePlatformAccountInput, PlatformAccount, PlatformAccountSyncStatus } from '@/types'
import { formatDateTime } from '@/utils/format'

const props = defineProps<{
  online: boolean
}>()

const emit = defineEmits<{
  authRequired: []
}>()

const accounts = ref<PlatformAccount[]>([])
const total = ref(0)
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const formError = ref('')
const notice = ref('')
const permissionDenied = ref(false)
const showCreate = ref(false)
const createButton = ref<HTMLButtonElement | null>(null)
const labelInput = ref<HTMLInputElement | null>(null)
const form = ref<CreatePlatformAccountInput>({
  platform: 'pdd',
  account_key: '',
  display_label: '',
})

function handleRequestError(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError && reason.status === 401) {
    emit('authRequired')
    return ''
  }
  if (reason instanceof ApiError && reason.status === 403) {
    permissionDenied.value = true
    return '仅管理员可以查看和登记拼多多采购账号。'
  }
  if (reason instanceof ApiError && reason.status === 0) return '网络不可用，暂时无法连接账号管理服务。'
  return reason instanceof Error ? reason.message : fallback
}

async function load(): Promise<void> {
  if (!props.online || loading.value || permissionDenied.value) return
  loading.value = true
  loadError.value = ''
  try {
    const response = await listPlatformAccounts('pdd')
    accounts.value = response.items
    total.value = response.total
  } catch (reason) {
    loadError.value = handleRequestError(reason, '拼多多账号列表加载失败')
  } finally {
    loading.value = false
  }
}

async function toggleCreate(): Promise<void> {
  showCreate.value = !showCreate.value
  formError.value = ''
  notice.value = ''
  await nextTick()
  if (showCreate.value) labelInput.value?.focus()
  else createButton.value?.focus()
}

function validateForm(): string {
  const label = form.value.display_label.trim()
  const key = form.value.account_key.trim().toLowerCase()
  if (!label || !key) return '请填写账号名称和账号标识'
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) {
    return '账号标识需为 1–64 位小写字母、数字、点、下划线或短横线，并以字母或数字开头'
  }
  return ''
}

async function submitCreate(): Promise<void> {
  if (saving.value || !props.online) return
  form.value.account_key = form.value.account_key.trim().toLowerCase()
  form.value.display_label = form.value.display_label.trim()
  const validationError = validateForm()
  if (validationError) {
    formError.value = validationError
    return
  }

  saving.value = true
  formError.value = ''
  notice.value = ''
  try {
    const created = await createPlatformAccount({ ...form.value })
    const existing = accounts.value.findIndex((account) => String(account.id) === String(created.id))
    if (existing >= 0) accounts.value.splice(existing, 1, created)
    else accounts.value = [...accounts.value, created]
    total.value = Math.max(total.value + (existing >= 0 ? 0 : 1), accounts.value.length)
    const createdLabel = created.display_label || created.account_key
    form.value = { platform: 'pdd', account_key: '', display_label: '' }
    showCreate.value = false
    notice.value = `已登记“${createdLabel}”。请在同步电脑上完成首次登录。`
    await nextTick()
    createButton.value?.focus()
  } catch (reason) {
    formError.value = handleRequestError(reason, '拼多多账号登记失败')
  } finally {
    saving.value = false
  }
}

function statusPresentation(status: PlatformAccountSyncStatus | null): { label: string; tone: string } {
  switch ((status || '').toUpperCase()) {
    case 'OK':
      return { label: '正常', tone: 'ok' }
    case 'NEEDS_LOGIN':
      return { label: '需登录', tone: 'attention' }
    case 'CAPTCHA_OR_BLOCKED':
      return { label: '需要验证', tone: 'attention' }
    case 'SCHEMA_CHANGED':
      return { label: '页面变化', tone: 'error' }
    case 'NETWORK_ERROR':
      return { label: '网络错误', tone: 'error' }
    case 'DISABLED':
      return { label: '本次未执行', tone: 'muted' }
    default:
      return { label: '未同步', tone: 'idle' }
  }
}

function accountTitle(account: PlatformAccount): string {
  return account.display_label?.trim() || account.account_key
}

watch(() => props.online, (isOnline) => {
  if (isOnline && !accounts.value.length) void load()
})

onMounted(() => void load())
</script>

<template>
  <section class="pdd-account-panel" aria-labelledby="pdd-accounts-title">
    <div class="pdd-account-heading">
      <div>
        <p class="eyebrow">采购来源</p>
        <h2 id="pdd-accounts-title">拼多多账号</h2>
        <p>这里只登记账号，不保存密码或 Cookie。首次登录和重新验证都在同步电脑完成。</p>
      </div>
      <div class="pdd-account-heading-actions">
        <button class="secondary-compact-button" type="button" :disabled="!online || loading || permissionDenied" @click="load">
          {{ loading ? '刷新中…' : '刷新状态' }}
        </button>
        <button ref="createButton" class="primary-compact-button" type="button" :disabled="!online || permissionDenied" @click="toggleCreate">
          {{ showCreate ? '取消登记' : '登记账号' }}
        </button>
      </div>
    </div>

    <form v-if="showCreate" class="pdd-account-form" @submit.prevent="submitCreate">
      <label>
        <span>账号名称</span>
        <input ref="labelInput" v-model="form.display_label" maxlength="128" autocomplete="off" placeholder="例如 主采购账号" />
      </label>
      <label>
        <span>账号标识</span>
        <input v-model="form.account_key" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="例如 pdd-main" />
      </label>
      <p class="pdd-form-hint">账号标识用于区分订单和浏览器配置，登记后应保持不变。请勿填写手机号、密码、Cookie 或 Token。</p>
      <p v-if="formError" class="pdd-form-error" role="alert">{{ formError }}</p>
      <button class="primary-button" type="submit" :disabled="saving || !online">
        {{ saving ? '登记中…' : '确认登记' }}
      </button>
    </form>

    <div v-if="loadError" class="people-message error" role="alert">
      <span>{{ loadError }}</span>
      <button v-if="online && !permissionDenied" type="button" @click="load">重试</button>
    </div>
    <p v-else-if="notice" class="people-message success" role="status">{{ notice }}</p>
    <p v-if="!online" class="people-message" role="status">当前离线，账号状态可能不是最新；联网后可重新加载。</p>

    <div v-if="loading && !accounts.length" class="people-loading" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>正在加载拼多多账号…</p>
    </div>
    <div v-else-if="!accounts.length && !loadError" class="pdd-account-empty">
      <strong>还没有登记拼多多账号</strong>
      <p>先登记账号名称和稳定标识，再到同步电脑完成登录。</p>
    </div>
    <div v-else class="pdd-account-list" :aria-label="`共 ${total} 个拼多多账号`">
      <article v-for="account in accounts" :key="account.id" class="pdd-account-card">
        <div class="pdd-account-card-topline">
          <div class="pdd-account-identity">
            <strong>{{ accountTitle(account) }}</strong>
            <code>{{ account.account_key }}</code>
          </div>
          <span class="pdd-status-chip" :class="`is-${statusPresentation(account.status).tone}`">
            {{ statusPresentation(account.status).label }}
          </span>
        </div>
        <dl class="pdd-account-metrics">
          <div>
            <dt>订单数</dt>
            <dd>{{ account.order_count ?? 0 }}</dd>
          </div>
          <div>
            <dt>最近检查</dt>
            <dd>{{ account.last_attempt_at ? formatDateTime(account.last_attempt_at) : '尚未检查' }}</dd>
          </div>
          <div>
            <dt>最近成功</dt>
            <dd>{{ account.last_success_at ? formatDateTime(account.last_success_at) : '尚未成功' }}</dd>
          </div>
        </dl>
        <p v-if="account.message && account.status !== 'OK'" class="pdd-account-message">{{ account.message }}</p>
        <p v-else class="pdd-account-footnote">登录与同步由同步电脑上的独立浏览器配置完成。</p>
      </article>
    </div>
  </section>
</template>
