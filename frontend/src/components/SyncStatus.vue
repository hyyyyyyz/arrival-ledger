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
      <span class="status-dot"></span>
      <span>网络</span>
      <strong>{{ online ? '在线' : '离线' }}</strong>
    </div>
    <div class="sync-item" :class="{ 'sync-warn': stats.pending + stats.uploading > 0 }">
      <span class="status-dot"></span>
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
      <span class="status-dot"></span>
      <span>失败</span>
      <strong>{{ stats.failed }}</strong>
    </button>
    <p v-if="!online" class="offline-caption">当前离线，照片会留在本机并在联网后自动上传</p>
  </section>
</template>
