<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ApiError, changePassword } from '@/services/api'

const props = defineProps<{ online: boolean }>()
const emit = defineEmits<{ authRequired: []; changed: [] }>()

const open = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const dialog = ref<HTMLElement | null>(null)
const currentInput = ref<HTMLInputElement | null>(null)
const form = ref({ current: '', next: '', confirmation: '' })

function validateNewPassword(password: string): string {
  if (Array.from(password).length < 12) return '新密码至少需要 12 个字符'
  if (new TextEncoder().encode(password).byteLength > 72) return '新密码按 UTF-8 计算不能超过 72 字节'
  const categories = [
    /\p{Ll}/u.test(password),
    /\p{Lu}/u.test(password),
    /\p{Nd}/u.test(password),
    /[^\p{L}\p{N}]/u.test(password),
  ]
  if (categories.filter(Boolean).length < 3) return '新密码需包含小写字母、大写字母、数字、符号中的至少 3 类'
  return ''
}

async function show(): Promise<void> {
  if (!props.online) return
  open.value = true
  error.value = ''
  notice.value = ''
  form.value = { current: '', next: '', confirmation: '' }
  await nextTick()
  currentInput.value?.focus()
}

function close(): void {
  if (!saving.value) open.value = false
}

async function submit(): Promise<void> {
  if (saving.value) return
  if (!form.value.current) {
    error.value = '请输入当前密码'
    return
  }
  if (form.value.next !== form.value.confirmation) {
    error.value = '两次输入的新密码不一致'
    return
  }
  const passwordError = validateNewPassword(form.value.next)
  if (passwordError) {
    error.value = passwordError
    return
  }
  saving.value = true
  error.value = ''
  try {
    await changePassword(form.value.current, form.value.next)
    notice.value = '密码已更新，请使用新密码登录其他设备。'
    form.value = { current: '', next: '', confirmation: '' }
    emit('changed')
    await nextTick()
    dialog.value?.focus()
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) emit('authRequired')
    else error.value = reason instanceof Error ? reason.message : '密码更新失败，请重试'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <button class="header-action-button" type="button" :disabled="!online" @click="show">修改密码</button>
  <div v-if="open" class="modal-backdrop" @click.self="close">
    <section ref="dialog" class="password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-title" tabindex="-1" @keydown.esc="close">
      <template v-if="notice">
        <h2 id="password-title">密码已更新</h2>
        <p class="password-notice" role="status">{{ notice }}</p>
        <div class="dialog-actions password-actions">
          <button class="confirm" type="button" @click="close">完成</button>
        </div>
      </template>
      <template v-else>
        <h2 id="password-title">修改密码</h2>
        <p>仅修改当前账号。其他设备上的登录会话会被撤销。</p>
        <form class="password-form" @submit.prevent="submit">
          <label><span>当前密码</span><input ref="currentInput" v-model="form.current" type="password" autocomplete="current-password" /></label>
          <label><span>新密码</span><input v-model="form.next" type="password" autocomplete="new-password" /></label>
          <label><span>确认新密码</span><input v-model="form.confirmation" type="password" autocomplete="new-password" /></label>
          <p class="form-security-hint">新密码至少 12 个字符，并包含至少 3 类字符。</p>
          <p v-if="error" class="password-error" role="alert">{{ error }}</p>
          <div class="dialog-actions password-actions">
            <button type="button" :disabled="saving" @click="close">取消</button>
            <button class="confirm" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存新密码' }}</button>
          </div>
        </form>
      </template>
    </section>
  </div>
</template>
