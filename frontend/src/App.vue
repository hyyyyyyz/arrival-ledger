<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import DashboardStats from '@/components/DashboardStats.vue'
import LoginView from '@/components/LoginView.vue'
import OrderList from '@/components/OrderList.vue'
import ReceiptCapture from '@/components/ReceiptCapture.vue'
import ReceiptList from '@/components/ReceiptList.vue'
import SyncStatus from '@/components/SyncStatus.vue'
import type {
  AuthSession,
  DashboardStats as DashboardStatsData,
  QueueStats,
  Receipt,
  UploadQueueItem,
  User,
} from '@/types'
import {
  ApiError,
  getCurrentSession,
  getDashboardStats,
  listReceipts,
  login as loginRequest,
  logout as logoutRequest,
  updateReceiptTracking,
} from '@/services/api'
import { uploadQueue } from '@/services/uploadQueue'
import { useAppTabs } from '@/composables/useAppTabs'
import { useOrderPage } from '@/composables/useOrderPage'
import { createQueuedRefresh } from '@/utils/queuedRefresh'
import { normalizeTrackingNo } from '@/utils/tracking'

const CACHED_USER_KEY = 'arrival-manager-last-user'
const CACHED_AUTH_REQUIRED_KEY = 'arrival-manager-auth-required'

const booting = ref(true)
const startupError = ref('')
const accessDenied = ref(false)
const user = ref<User | null>(null)
const authRequired = ref(true)
const loginLoading = ref(false)
const loginError = ref('')
const sessionNotice = ref('')
const online = ref(navigator.onLine)
const receipts = ref<Receipt[]>([])
const receiptsLoading = ref(false)
const dashboardStats = ref<DashboardStatsData | null>(null)
const dashboardStatsLoading = ref(false)
const dashboardStatsError = ref('')
const queueItems = ref<UploadQueueItem[]>([])
const queueStats = ref<QueueStats>({ pending: 0, failed: 0, uploading: 0 })
const dashboardRefresh = createQueuedRefresh()
let dashboardRequestVersion = 0

const {
  orders,
  total: orderTotal,
  limit: orderLimit,
  offset: orderOffset,
  query: orderQuery,
  platform: orderPlatform,
  loading: ordersLoading,
  error: ordersError,
  activate: activateOrders,
  search: searchOrders,
  goToPage: goToOrderPage,
  refresh: refreshOrders,
  invalidate: invalidateOrders,
  reset: resetOrders,
} = useOrderPage({
  isOnline: () => online.value,
  onAuthRequired: () => handleAuthRequired(),
})

const { activeTab, pageTitle, selectTab, reset: resetActiveTab } = useAppTabs(() => {
  void activateOrders()
})

const recentReceipts = computed(() => receipts.value.slice(0, 5))
const recentQueueItems = computed(() => queueItems.value.slice(0, 5))

function cachedUser(): User | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

function cachedAuthRequired(): boolean {
  return localStorage.getItem(CACHED_AUTH_REQUIRED_KEY) !== 'false'
}

function activateUser(nextUser: User, offlineFallback = false, requiresAuth = true): void {
  resetDashboardStats()
  resetOrders()
  resetActiveTab()
  user.value = nextUser
  authRequired.value = requiresAuth
  localStorage.setItem(CACHED_USER_KEY, JSON.stringify(nextUser))
  localStorage.setItem(CACHED_AUTH_REQUIRED_KEY, String(requiresAuth))
  uploadQueue.setAuthenticatedUser(nextUser.id)
  sessionNotice.value = offlineFallback ? '服务器暂时不可达，当前可继续拍照；联网后会自动验证并同步。' : ''
  void refreshQueueState()
  if (online.value) void refreshReceipts()
}

function activateSession(session: AuthSession, offlineFallback = false): void {
  activateUser(session.user, offlineFallback, session.authRequired)
}

async function bootstrap(): Promise<void> {
  try {
    await uploadQueue.initialize()
    try {
      activateSession(await getCurrentSession())
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) {
        const previousUser = cachedUser()
        if (previousUser) activateUser(previousUser, true, cachedAuthRequired())
        else startupError.value = '暂时无法连接服务器，请联网后重试。'
      } else if (error instanceof ApiError && error.status === 403) {
        accessDenied.value = true
        startupError.value = '请连接仓库局域网后再打开此页面。'
      }
    }
  } catch (error) {
    startupError.value = error instanceof Error ? error.message : '本地存储初始化失败'
  } finally {
    booting.value = false
  }
}

async function handleLogin(username: string, password: string): Promise<void> {
  loginLoading.value = true
  loginError.value = ''
  try {
    activateSession(await loginRequest(username, password))
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '登录失败，请重试'
  } finally {
    loginLoading.value = false
  }
}

async function handleLogout(): Promise<void> {
  if (queueStats.value.pending + queueStats.value.failed + queueStats.value.uploading > 0) {
    const confirmed = window.confirm('本机还有未同步照片。退出不会删除照片，但需再次登录当前账号才能继续上传。确定退出吗？')
    if (!confirmed) return
  }

  try {
    await logoutRequest()
  } catch {
    // Clear the local session even when the server is temporarily unreachable.
  }
  user.value = null
  receipts.value = []
  resetDashboardStats()
  resetOrders()
  resetActiveTab()
  queueItems.value = []
  uploadQueue.setAuthenticatedUser(null)
  localStorage.removeItem(CACHED_USER_KEY)
  localStorage.removeItem(CACHED_AUTH_REQUIRED_KEY)
}

async function refreshQueueState(): Promise<void> {
  if (!user.value) return
  const [items, stats] = await Promise.all([uploadQueue.itemsForCurrentUser(), uploadQueue.stats()])
  queueItems.value = items
  queueStats.value = stats
}

function resetDashboardStats(): void {
  dashboardRequestVersion += 1
  dashboardRefresh.reset()
  dashboardStats.value = null
  dashboardStatsLoading.value = false
  dashboardStatsError.value = ''
}

async function performDashboardStatsRefresh(): Promise<void> {
  const requestVersion = dashboardRequestVersion

  dashboardStatsLoading.value = true
  dashboardStatsError.value = ''
  try {
    const nextStats = await getDashboardStats()
    if (requestVersion === dashboardRequestVersion && user.value) dashboardStats.value = nextStats
  } catch (error) {
    if (requestVersion !== dashboardRequestVersion || !user.value) return
    if (error instanceof ApiError && error.status === 401) handleAuthRequired()
    else dashboardStatsError.value = '订单统计暂时不可用，不影响拍照收货。'
  } finally {
    if (requestVersion === dashboardRequestVersion) dashboardStatsLoading.value = false
  }
}

function refreshDashboardStats(): void {
  if (!user.value || !online.value) return
  void dashboardRefresh.request(performDashboardStatsRefresh)
}

async function refreshReceipts(): Promise<void> {
  if (!user.value || !online.value || receiptsLoading.value) return
  void refreshDashboardStats()
  receiptsLoading.value = true
  try {
    receipts.value = await listReceipts(80)
    sessionNotice.value = ''
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) handleAuthRequired()
    else sessionNotice.value = error instanceof Error ? error.message : '到货记录刷新失败'
  } finally {
    receiptsLoading.value = false
  }
}

async function updateLocalTracking(clientEventId: string, trackingNo: string): Promise<void> {
  try {
    await uploadQueue.updateTracking(clientEventId, normalizeTrackingNo(trackingNo))
    await refreshQueueState()
  } catch (error) {
    sessionNotice.value = error instanceof Error ? error.message : '本机单号更新失败'
  }
}

async function updateServerTracking(receiptId: string | number, trackingNo: string): Promise<void> {
  try {
    const updated = await updateReceiptTracking(receiptId, normalizeTrackingNo(trackingNo))
    const index = receipts.value.findIndex((item) => item.id === receiptId)
    if (index >= 0) receipts.value.splice(index, 1, updated)
    handleServerReceiptChanged()
  } catch (error) {
    sessionNotice.value = error instanceof Error ? error.message : '单号更新失败'
  }
}

function handleQueueChange(): void {
  void refreshQueueState()
}

function handleSynced(event: Event): void {
  const receipt = (event as CustomEvent<Receipt>).detail
  const existing = receipts.value.findIndex((item) => item.id === receipt.id)
  if (existing >= 0) receipts.value.splice(existing, 1, receipt)
  else receipts.value.unshift(receipt)
  void refreshQueueState()
  handleServerReceiptChanged()
}

function handleServerReceiptChanged(): void {
  void refreshDashboardStats()
  invalidateOrders()
  if (activeTab.value === 'orders') void refreshOrders()
}

function handleAuthRequired(): void {
  sessionNotice.value = '登录已过期，请重新登录；本机照片不会丢失。'
  authRequired.value = true
  user.value = null
  resetDashboardStats()
  resetOrders()
  resetActiveTab()
  uploadQueue.setAuthenticatedUser(null)
  localStorage.removeItem(CACHED_USER_KEY)
  localStorage.removeItem(CACHED_AUTH_REQUIRED_KEY)
}

function handleOnline(): void {
  online.value = true
  if (user.value) {
    uploadQueue.setAuthenticatedUser(user.value.id)
    void refreshReceipts()
    if (activeTab.value === 'orders') void refreshOrders()
  }
}

function handleOffline(): void {
  online.value = false
}

function reloadPage(): void {
  window.location.reload()
}

onMounted(() => {
  uploadQueue.addEventListener('change', handleQueueChange)
  uploadQueue.addEventListener('synced', handleSynced)
  uploadQueue.addEventListener('auth-required', handleAuthRequired)
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  void bootstrap()
})

onBeforeUnmount(() => {
  uploadQueue.removeEventListener('change', handleQueueChange)
  uploadQueue.removeEventListener('synced', handleSynced)
  uploadQueue.removeEventListener('auth-required', handleAuthRequired)
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
})
</script>

<template>
  <div v-if="booting" class="boot-screen">
    <div class="brand-mark">✓</div>
    <span class="spinner"></span>
    <p>正在恢复本机收货队列…</p>
  </div>

  <main v-else-if="accessDenied" class="login-shell">
    <section class="login-card">
      <div class="login-logo" aria-hidden="true"><span>⌁</span></div>
      <p class="eyebrow">仅限仓库局域网</p>
      <h1>暂时无法直接访问</h1>
      <p class="login-intro">{{ startupError }}</p>
      <button class="primary-button login-button" type="button" @click="reloadPage">重新检查</button>
    </section>
  </main>

  <LoginView v-else-if="!user" :loading="loginLoading" :error="loginError || startupError || sessionNotice" @submit="handleLogin" />

  <div v-else class="app-shell">
    <header class="app-header">
      <div>
        <p class="app-kicker">到货管家</p>
        <h1>{{ pageTitle }}</h1>
      </div>
      <button v-if="authRequired" class="user-button" type="button" title="退出登录" @click="handleLogout">
        <span>{{ user.display_name.slice(0, 1) }}</span>
        <small>{{ user.display_name }}</small>
      </button>
      <div v-else class="user-button user-button-static" title="局域网直接使用">
        <span>✓</span>
        <small>直接使用</small>
      </div>
    </header>

    <div v-if="sessionNotice" class="notice-banner" role="status">{{ sessionNotice }}</div>

    <main class="app-content">
      <template v-if="activeTab !== 'orders'">
        <DashboardStats
          :stats="dashboardStats"
          :loading="dashboardStatsLoading"
          :error="dashboardStatsError"
          :online="online"
          @retry="refreshDashboardStats"
        />
        <SyncStatus :stats="queueStats" :online="online" @retry="uploadQueue.retryNow()" />
      </template>

      <template v-if="activeTab === 'capture'">
        <ReceiptCapture :user="user" @changed="refreshQueueState" @server-changed="handleServerReceiptChanged" />
        <ReceiptList
          :receipts="recentReceipts"
          :local-items="recentQueueItems"
          :loading="receiptsLoading"
          title="最近到货"
          @refresh="refreshReceipts"
          @retry="uploadQueue.retryNow"
          @update-local="updateLocalTracking"
          @update-server="updateServerTracking"
        />
      </template>

      <ReceiptList
        v-else-if="activeTab === 'records'"
        :receipts="receipts"
        :local-items="queueItems"
        :loading="receiptsLoading"
        title="全部记录"
        empty-text="还没有可查看的到货记录。"
        @refresh="refreshReceipts"
        @retry="uploadQueue.retryNow"
        @update-local="updateLocalTracking"
        @update-server="updateServerTracking"
      />

      <OrderList
        v-else
        :orders="orders"
        :total="orderTotal"
        :limit="orderLimit"
        :offset="orderOffset"
        :query="orderQuery"
        :platform="orderPlatform"
        :loading="ordersLoading"
        :error="ordersError"
        :online="online"
        @search="searchOrders"
        @refresh="refreshOrders"
        @page="goToOrderPage"
      />
    </main>

    <nav class="bottom-nav" aria-label="主导航">
      <button type="button" :class="{ active: activeTab === 'capture' }" :aria-current="activeTab === 'capture' ? 'page' : undefined" @click="selectTab('capture')">
        <span aria-hidden="true">＋</span>
        收货
      </button>
      <button type="button" :class="{ active: activeTab === 'records' }" :aria-current="activeTab === 'records' ? 'page' : undefined" @click="selectTab('records')">
        <span aria-hidden="true">☷</span>
        记录
      </button>
      <button type="button" :class="{ active: activeTab === 'orders' }" :aria-current="activeTab === 'orders' ? 'page' : undefined" @click="selectTab('orders')">
        <span aria-hidden="true">▤</span>
        订单
      </button>
    </nav>
  </div>
</template>
