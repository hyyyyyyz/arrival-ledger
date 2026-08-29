<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  loading: boolean
  error: string
}>()

const emit = defineEmits<{
  submit: [username: string, password: string]
}>()

const username = ref('')
const password = ref('')

function submit(): void {
  if (!username.value.trim() || !password.value) return
  emit('submit', username.value.trim(), password.value)
}
</script>

<template>
  <main class="login-shell">
    <section class="login-card">
      <div class="login-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>
      </div>
      <p class="eyebrow">私人收货记录</p>
      <h1>到货管家</h1>
      <p class="login-intro">收到一个，拍下一个。照片会先保存在本机，断网也不怕丢。</p>

      <form class="login-form" @submit.prevent="submit">
        <label>
          <span>账号</span>
          <input
            v-model="username"
            name="username"
            autocomplete="username"
            autocapitalize="none"
            enterkeyhint="next"
            placeholder="请输入账号"
            :disabled="props.loading"
          />
        </label>
        <label>
          <span>密码</span>
          <input
            v-model="password"
            name="password"
            type="password"
            autocomplete="current-password"
            enterkeyhint="go"
            placeholder="请输入密码"
            :disabled="props.loading"
          />
        </label>
        <p v-if="props.error" class="form-error" role="alert">{{ props.error }}</p>
        <button class="primary-button login-button" type="submit" :disabled="props.loading || !username.trim() || !password">
          <span v-if="props.loading" class="spinner" aria-hidden="true"></span>
          {{ props.loading ? '正在登录…' : '登录' }}
        </button>
      </form>

      <p class="privacy-note">仅限已配置的固定账号使用，不提供公开注册。</p>
    </section>
  </main>
</template>
