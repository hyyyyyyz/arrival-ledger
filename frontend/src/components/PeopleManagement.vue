<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { ApiError, createUser, listUsers, setUserActive } from '@/services/api'
import type { CreateUserInput, ManagedUser, User } from '@/types'
import { formatDateTime } from '@/utils/format'

const props = defineProps<{
  currentUser: User
  online: boolean
}>()

const emit = defineEmits<{
  authRequired: []
}>()

const users = ref<ManagedUser[]>([])
const loading = ref(false)
const saving = ref(false)
const togglingUserId = ref<string | number | null>(null)
const error = ref('')
const notice = ref('')
const showCreate = ref(false)
const pendingToggle = ref<ManagedUser | null>(null)
const confirmDialog = ref<HTMLElement | null>(null)
const toggleError = ref('')
const returnFocusTarget = ref<HTMLElement | null>(null)
const returnFocusUserId = ref('')
const peoplePage = ref<HTMLElement | null>(null)
const createButton = ref<HTMLButtonElement | null>(null)
const usernameInput = ref<HTMLInputElement | null>(null)
const form = ref<CreateUserInput & { password_confirmation: string }>({
  username: '',
  display_name: '',
  password: '',
  password_confirmation: '',
  role: 'RECEIVER',
})

function handleError(reason: unknown, fallback: string): void {
  if (reason instanceof ApiError && reason.status === 401) {
    emit('authRequired')
    return
  }
  error.value = reason instanceof Error ? reason.message : fallback
}

async function load(): Promise<void> {
  if (!props.online || loading.value) return
  loading.value = true
  error.value = ''
  try {
    users.value = await listUsers()
  } catch (reason) {
    handleError(reason, '人员列表加载失败')
  } finally {
    loading.value = false
  }
}

async function submitCreate(): Promise<void> {
  if (saving.value) return
  const input: CreateUserInput = {
    username: form.value.username.trim(),
    display_name: form.value.display_name.trim(),
    password: form.value.password,
    role: form.value.role,
  }
  if (!input.username || !input.display_name) {
    error.value = '请填写登录账号和姓名'
    return
  }
  if (input.password !== form.value.password_confirmation) {
    error.value = '两次输入的密码不一致'
    return
  }
  const passwordError = validatePassword(input.password)
  if (passwordError) {
    error.value = passwordError
    return
  }
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const created = await createUser(input)
    users.value = [...users.value, created]
    form.value = { username: '', display_name: '', password: '', password_confirmation: '', role: 'RECEIVER' }
    showCreate.value = false
    notice.value = `已创建 ${created.display_name} 的账号`
    await nextTick()
    createButton.value?.focus()
  } catch (reason) {
    handleError(reason, '账号创建失败')
  } finally {
    saving.value = false
  }
}

function validatePassword(password: string): string {
  if (Array.from(password).length < 12) return '密码至少需要 12 个字符'
  if (new TextEncoder().encode(password).byteLength > 72) return '密码按 UTF-8 计算不能超过 72 字节（中文通常占 3 字节）'
  const categories = [
    /\p{Ll}/u.test(password),
    /\p{Lu}/u.test(password),
    /\p{Nd}/u.test(password),
    /[^\p{L}\p{N}]/u.test(password),
  ]
  if (categories.filter(Boolean).length < 3) return '密码需包含小写字母、大写字母、数字、符号中的至少 3 类'
  return ''
}

async function toggleCreate(): Promise<void> {
  showCreate.value = !showCreate.value
  error.value = ''
  await nextTick()
  if (showCreate.value) usernameInput.value?.focus()
  else createButton.value?.focus()
}

async function askToggle(user: ManagedUser, event: MouseEvent): Promise<void> {
  if (String(user.id) === String(props.currentUser.id)) return
  returnFocusTarget.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  returnFocusUserId.value = String(user.id)
  pendingToggle.value = user
  error.value = ''
  toggleError.value = ''
  await nextTick()
  confirmDialog.value?.focus()
}

async function restoreToggleFocus(): Promise<void> {
  const target = returnFocusTarget.value
  const targetUserId = returnFocusUserId.value
  returnFocusTarget.value = null
  returnFocusUserId.value = ''
  await nextTick()
  const currentTarget = Array.from(peoplePage.value?.querySelectorAll<HTMLElement>('.person-toggle') || [])
    .find((button) => button.dataset.userId === targetUserId)
  ;(currentTarget || target)?.focus()
}

async function closeToggle(): Promise<void> {
  if (togglingUserId.value !== null) return
  pendingToggle.value = null
  toggleError.value = ''
  await restoreToggleFocus()
}

async function confirmToggle(): Promise<void> {
  const target = pendingToggle.value
  if (!target || togglingUserId.value !== null) return
  let completed = false
  togglingUserId.value = target.id
  error.value = ''
  notice.value = ''
  try {
    const updated = await setUserActive(target.id, !target.is_active)
    const index = users.value.findIndex((user) => String(user.id) === String(updated.id))
    if (index >= 0) users.value.splice(index, 1, updated)
    notice.value = `${updated.display_name} 已${updated.is_active ? '启用' : '停用'}`
    pendingToggle.value = null
    completed = true
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) emit('authRequired')
    else toggleError.value = reason instanceof Error ? reason.message : '账号状态更新失败'
    await nextTick()
    confirmDialog.value?.focus()
  } finally {
    togglingUserId.value = null
    if (completed) await restoreToggleFocus()
  }
}

function roleLabel(role: ManagedUser['role']): string {
  return role === 'ADMIN' ? '管理员' : '收货员'
}

onMounted(() => void load())
</script>

<template>
  <section ref="peoplePage" class="people-page" aria-labelledby="people-title">
    <div class="people-heading">
      <div>
        <p class="eyebrow">账号与责任</p>
        <h2 id="people-title">人员管理</h2>
        <p>每位同事使用自己的账号，拍摄和人工纠正都会留下责任人。</p>
      </div>
      <button ref="createButton" class="primary-compact-button" type="button" :disabled="!online" @click="toggleCreate">
        {{ showCreate ? '取消新增' : '新增人员' }}
      </button>
    </div>

    <form v-if="showCreate" class="person-create-form" @submit.prevent="submitCreate">
      <label>
        <span>登录账号</span>
        <input ref="usernameInput" v-model="form.username" maxlength="64" autocomplete="off" placeholder="例如 zhangsan" />
      </label>
      <label>
        <span>姓名</span>
        <input v-model="form.display_name" maxlength="64" autocomplete="name" placeholder="用于责任记录" />
      </label>
      <label>
        <span>初始密码</span>
        <input v-model="form.password" type="password" minlength="12" maxlength="256" autocomplete="new-password" aria-describedby="password-requirements" placeholder="至少 12 位，不会回显" />
      </label>
      <label>
        <span>再次输入密码</span>
        <input v-model="form.password_confirmation" type="password" minlength="12" maxlength="256" autocomplete="new-password" placeholder="再次确认，避免输错" />
      </label>
      <label>
        <span>权限</span>
        <select v-model="form.role">
          <option value="RECEIVER">收货员</option>
          <option value="ADMIN">管理员</option>
        </select>
      </label>
      <p id="password-requirements" class="form-security-hint">密码需 12 个字符以上，包含小写字母、大写字母、数字、符号中的至少 3 类；UTF-8 编码不超过 72 字节。密码只在创建时提交，之后不会显示。</p>
      <button class="primary-button" type="submit" :disabled="saving || !online">
        {{ saving ? '创建中…' : '创建账号' }}
      </button>
    </form>

    <div v-if="error" class="people-message error" role="alert">
      <span>{{ error }}</span>
      <button v-if="!showCreate && online" type="button" @click="load">重试</button>
    </div>
    <p v-else-if="notice" class="people-message success" role="status">{{ notice }}</p>
    <p v-if="!online" class="people-message" role="status">当前离线，联网后才能管理账号。</p>

    <div v-if="loading && !users.length" class="people-loading" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>正在加载人员…</p>
    </div>
    <div v-else class="people-list">
      <article v-for="person in users" :key="person.id" class="person-card" :class="{ inactive: !person.is_active }">
        <span class="person-avatar" aria-hidden="true">{{ person.display_name.slice(0, 1) }}</span>
        <div class="person-identity">
          <div>
            <strong>{{ person.display_name }}</strong>
            <span v-if="String(person.id) === String(currentUser.id)" class="current-user-chip">当前账号</span>
          </div>
          <p>@{{ person.username }} · {{ roleLabel(person.role) }}</p>
          <small>{{ person.is_active ? '账号已启用' : '账号已停用，无法登录' }}<template v-if="person.last_login_at"> · 最近登录 {{ formatDateTime(person.last_login_at) }}</template></small>
        </div>
        <button
          class="person-toggle"
          :class="{ danger: person.is_active }"
          :data-user-id="String(person.id)"
          type="button"
          :disabled="String(person.id) === String(currentUser.id) || togglingUserId !== null || !online"
          @click="askToggle(person, $event)"
        >
          {{ person.is_active ? '停用' : '启用' }}
        </button>
      </article>
    </div>

    <div v-if="pendingToggle" class="modal-backdrop" @click.self="closeToggle">
      <section
        ref="confirmDialog"
        class="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-confirm-title"
        tabindex="-1"
        @keydown.esc="closeToggle"
      >
        <span class="dialog-icon" :class="{ danger: pendingToggle.is_active }" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M4.9 19h14.2a2 2 0 0 0 1.73-3L13.73 3.7a2 2 0 0 0-3.46 0L3.17 16A2 2 0 0 0 4.9 19Z" /></svg>
        </span>
        <h3 id="person-confirm-title">{{ pendingToggle.is_active ? '停用这个账号？' : '重新启用这个账号？' }}</h3>
        <p v-if="pendingToggle.is_active">{{ pendingToggle.display_name }} 将立即无法登录；已有拍摄和修改记录仍会保留。</p>
        <p v-else>{{ pendingToggle.display_name }} 将可以重新登录，原有责任记录不受影响。</p>
        <p v-if="toggleError" class="dialog-error" role="alert">{{ toggleError }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="togglingUserId !== null" @click="closeToggle">取消</button>
          <button class="confirm" :class="{ danger: pendingToggle.is_active }" type="button" :disabled="togglingUserId !== null" @click="confirmToggle">
            {{ togglingUserId !== null ? '保存中…' : pendingToggle.is_active ? '确认停用' : '确认启用' }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
