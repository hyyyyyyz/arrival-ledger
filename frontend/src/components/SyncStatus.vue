<script setup lang="ts">
import type { QueueStats } from '@/types'

defineProps<{
  stats: QueueStats
  online: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <section class="sync-panel" aria-label="同步状态">
    <div class="sync-item" :class="{ 'sync-ok': online }">
      <span class="sync-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 9a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M11 15a2 2 0 0 1 2 0" /><circle cx="12" cy="18" r="1" /></svg></span>
      <span>网络</span>
      <strong>{{ online ? '在线' : '离线' }}</strong>
    </div>
    <div class="sync-item" :class="{ 'sync-warn': stats.pending + stats.uploading > 0 }">
      <span class="sync-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 16V4m-4 4 4-4 4 4M5 14v5h14v-5" /></svg></span>
      <span>{{ stats.uploading ? '上传中' : '待上传' }}</span>
      <strong>{{ stats.pending + stats.uploading }}</strong>
    </div>
    <button
      class="sync-item sync-error"
      :class="{ active: stats.failed > 0 }"
      type="button"
      :disabled="stats.failed === 0 || !online"
      @click="emit('retry')"
    >
      <span class="sync-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 4 21 20H3Zm0 5v5m0 3h.01" /></svg></span>
      <span>失败</span>
      <strong>{{ stats.failed }}</strong>
    </button>
    <p v-if="!online" class="offline-caption">当前离线，照片会留在本机并在联网后自动上传</p>
  </section>
</template>
