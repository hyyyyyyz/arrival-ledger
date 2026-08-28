<script setup lang="ts">
import type { DashboardStats } from '@/types'

defineProps<{
  stats: DashboardStats | null
  loading: boolean
  error: string
  online: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()

const numberFormatter = new Intl.NumberFormat('zh-CN')

function formatCount(value: number | undefined): string {
  return value === undefined ? '—' : numberFormatter.format(value)
}

function pendingReviewCount(stats: DashboardStats | null): number | undefined {
  if (!stats) return undefined
  return (stats.candidate_photos ?? 0) + stats.unmatched_photos
}
</script>

<template>
  <section class="dashboard-panel" aria-labelledby="dashboard-title" :aria-busy="loading">
    <header class="dashboard-heading">
      <div>
        <p class="eyebrow">订单概览</p>
        <h2 id="dashboard-title">采购与到货</h2>
      </div>
      <span v-if="loading" class="dashboard-updating" role="status">
        <span class="spinner" aria-hidden="true"></span>
        更新中
      </span>
    </header>

    <div class="dashboard-grid">
      <article class="dashboard-card dashboard-orders">
        <span>采购订单</span>
        <strong>{{ formatCount(stats?.total_orders) }}</strong>
        <small>已导入订单</small>
      </article>
      <article class="dashboard-card dashboard-arrivals">
        <span>到货照片</span>
        <strong>{{ formatCount(stats?.arrival_photos) }}</strong>
        <small>去重后的有效首次凭证</small>
      </article>
      <article class="dashboard-card dashboard-matched">
        <span>已确认关联</span>
        <strong>{{ formatCount(stats?.matched_orders) }}</strong>
        <small>照片已关联订单</small>
      </article>
      <article class="dashboard-card dashboard-review">
        <span>待确认照片</span>
        <strong>{{ formatCount(pendingReviewCount(stats)) }}</strong>
        <small>候选或未关联</small>
      </article>
    </div>

    <div v-if="error" class="dashboard-message dashboard-message-error" role="status">
      <span>{{ error }}</span>
      <button v-if="online" type="button" @click="emit('retry')">重新加载</button>
    </div>
    <p v-else-if="!stats && !loading" class="dashboard-message" role="status">
      {{ online ? '统计数据尚未加载，不影响拍照收货。' : '当前离线，联网后会显示服务器订单统计。' }}
    </p>
  </section>
</template>
