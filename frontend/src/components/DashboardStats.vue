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
  return (stats.review_orders ?? 0) + stats.unmatched_photos
}

function receivedOrderCount(stats: DashboardStats | null): number | undefined {
  if (!stats) return undefined
  return stats.received_orders ?? Math.max(0, stats.total_orders - stats.pending_orders)
}
</script>

<template>
  <section class="dashboard-panel" aria-labelledby="dashboard-title" :aria-busy="loading">
    <header class="dashboard-heading">
      <div>
        <p class="eyebrow">今日台账</p>
        <h2 id="dashboard-title">收货概览</h2>
      </div>
      <span v-if="loading" class="dashboard-updating" role="status">
        <span class="spinner" aria-hidden="true"></span>
        更新中
      </span>
    </header>

    <div class="dashboard-grid">
      <article class="dashboard-card dashboard-orders">
        <span>总订单</span>
        <strong>{{ formatCount(stats?.total_orders) }}</strong>
        <small>已同步采购订单</small>
      </article>
      <article class="dashboard-card dashboard-pending">
        <span>未收货</span>
        <strong>{{ formatCount(stats?.pending_orders) }}</strong>
        <small>仍需拍照确认</small>
      </article>
      <article class="dashboard-card dashboard-received">
        <span>已收货</span>
        <strong>{{ formatCount(receivedOrderCount(stats)) }}</strong>
        <small>{{ formatCount(stats?.arrival_photos) }} 张到货凭证</small>
      </article>
      <article class="dashboard-card dashboard-review">
        <span>待处理</span>
        <strong>{{ formatCount(pendingReviewCount(stats)) }}</strong>
        <small>部分收货、候选或未匹配</small>
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
