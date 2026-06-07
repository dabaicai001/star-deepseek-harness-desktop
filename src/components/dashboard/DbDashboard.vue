<script setup lang="ts">
/**
 * 数据库仪表盘
 * 展示数据库基本信息和运行状态
 */
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import DashboardCard from './DashboardCard.vue'

const props = defineProps<{
  connId: string
  dbType: string
  connected: boolean
}>()

// 仪表盘数据
const loading = ref(true)
const refreshing = ref(false)
const data = ref({
  version: '--',
  uptime: '--',
  connections: 0,
  maxConnections: 0,
  queries: 0,
  slowQueries: 0,
  questions: 0,
  tableCount: 0,
  dataSize: 0,
  indexSize: 0,
  cacheHitRate: 0,
  bufferPoolSize: 0,
  bufferPoolUsed: 0,
  threadsRunning: 0,
  threadsConnected: 0,
  bytesReceived: 0,
  bytesSent: 0
})

// 格式化字节
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

// 格式化运行时间
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${mins}分钟`
  return `${mins}分钟`
}

// 格式化数字（添加千位分隔符）
function formatNumber(num: number): string {
  return num.toLocaleString()
}

// 连接使用率
const connectionUsage = computed(() => {
  if (data.value.maxConnections === 0) return 0
  return (data.value.connections / data.value.maxConnections) * 100
})

// 连接副标题
const connectionSubtitle = computed(() => {
  return `${data.value.threadsRunning} 活跃 / ${data.value.maxConnections} 最大`
})

// 缓存命中率副标题
const cacheSubtitle = computed(() => {
  return formatBytes(data.value.bufferPoolUsed) + ' / ' + formatBytes(data.value.bufferPoolSize)
})

// 数据大小副标题
const dataSizeSubtitle = computed(() => {
  return `索引: ${formatBytes(data.value.indexSize)}`
})

// 数据库类型显示名称
const dbTypeName = computed(() => {
  switch (props.dbType) {
    case 'mysql': return 'MySQL'
    case 'postgresql': return 'PostgreSQL'
    case 'redis': return 'Redis'
    case 'sqlite': return 'SQLite'
    default: return props.dbType.toUpperCase()
  }
})

// 模拟 MySQL 数据
function loadMockData(silent = false) {
  if (!silent) {
    loading.value = true
  } else {
    refreshing.value = true
  }
  setTimeout(() => {
    if (props.dbType === 'redis') {
      data.value = {
        version: '7.2.3',
        uptime: '30天 12小时',
        connections: 15,
        maxConnections: 10000,
        queries: 1258963,
        slowQueries: 0,
        questions: 0,
        tableCount: 0,
        dataSize: 256 * 1024 * 1024,
        indexSize: 0,
        cacheHitRate: 99.2,
        bufferPoolSize: 512 * 1024 * 1024,
        bufferPoolUsed: 256 * 1024 * 1024,
        threadsRunning: 2,
        threadsConnected: 15,
        bytesReceived: 2.5 * 1024 * 1024 * 1024,
        bytesSent: 8.2 * 1024 * 1024 * 1024
      }
    } else {
      data.value = {
        version: '8.0.35',
        uptime: '45天 6小时',
        connections: 28,
        maxConnections: 151,
        queries: 5689421,
        slowQueries: 12,
        questions: 5689421,
        tableCount: 156,
        dataSize: 2.8 * 1024 * 1024 * 1024,
        indexSize: 1.2 * 1024 * 1024 * 1024,
        cacheHitRate: 98.5,
        bufferPoolSize: 4 * 1024 * 1024 * 1024,
        bufferPoolUsed: 3.2 * 1024 * 1024 * 1024,
        threadsRunning: 5,
        threadsConnected: 28,
        bytesReceived: 15.6 * 1024 * 1024 * 1024,
        bytesSent: 45.2 * 1024 * 1024 * 1024
      }
    }
    loading.value = false
    refreshing.value = false
  }, silent ? 300 : 600)
}

// 刷新数据（无感知）
function refresh() {
  loadMockData(true)
}

// 自动刷新定时器
let refreshTimer: number | null = null

onMounted(() => {
  loadMockData()
  refreshTimer = window.setInterval(refresh, 30000)
})

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
})
</script>

<template>
  <div class="db-dashboard">
    <div class="dashboard-header">
      <div class="header-info">
        <v-icon size="16" color="purple">mdi-database</v-icon>
        <span class="db-type">{{ dbTypeName }}</span>
        <span class="version">v{{ data.version }}</span>
      </div>
      <button class="refresh-btn" @click="refresh" :disabled="loading">
        <v-icon size="14" :class="{ spinning: loading }">mdi-refresh</v-icon>
      </button>
    </div>

    <div class="dashboard-grid">
      <!-- 运行时间 -->
      <DashboardCard
        title="运行时间"
        icon="mdi-clock-outline"
        :value="data.uptime"
        color="cyan"
        :loading="loading"
      />

      <!-- 连接数 -->
      <DashboardCard
        title="连接数"
        icon="mdi-connection"
        :value="data.connections"
        :subtitle="connectionSubtitle"
        :progress="connectionUsage"
        :color="connectionUsage > 80 ? 'red' : connectionUsage > 50 ? 'yellow' : 'green'"
        :loading="loading"
      />

      <!-- 查询总数 -->
      <DashboardCard
        title="查询总数"
        icon="mdi-database-search"
        :value="formatNumber(data.queries)"
        color="cyan"
        :loading="loading"
      />

      <!-- 慢查询 -->
      <DashboardCard
        title="慢查询"
        icon="mdi-turtle"
        :value="data.slowQueries"
        :color="data.slowQueries > 100 ? 'red' : data.slowQueries > 10 ? 'yellow' : 'green'"
        :loading="loading"
      />

      <!-- 缓存命中率 -->
      <DashboardCard
        :title="dbType === 'redis' ? '内存使用' : '缓冲池命中率'"
        :icon="dbType === 'redis' ? 'mdi-memory' : 'mdi-buffer'"
        :value="data.cacheHitRate.toFixed(1) + '%'"
        :subtitle="cacheSubtitle"
        :progress="data.cacheHitRate"
        color="purple"
        :loading="loading"
      />

      <!-- 数据大小 -->
      <DashboardCard
        :title="dbType === 'redis' ? '已用内存' : '数据大小'"
        icon="mdi-database-arrow-down"
        :value="formatBytes(data.dataSize)"
        :subtitle="dbType !== 'redis' ? dataSizeSubtitle : undefined"
        color="blue"
        :loading="loading"
      />

      <!-- 表数量 (MySQL/PostgreSQL) -->
      <DashboardCard
        v-if="dbType !== 'redis'"
        title="表数量"
        icon="mdi-table"
        :value="data.tableCount"
        color="cyan"
        :loading="loading"
      />

      <!-- 活跃线程 -->
      <DashboardCard
        title="活跃线程"
        icon="mdi-application-cog"
        :value="data.threadsRunning"
        :subtitle="`${data.threadsConnected} 已连接`"
        color="green"
        :loading="loading"
      />

      <!-- 网络流量 -->
      <DashboardCard
        title="网络接收"
        icon="mdi-download-network"
        :value="formatBytes(data.bytesReceived)"
        color="blue"
        :loading="loading"
      />

      <DashboardCard
        title="网络发送"
        icon="mdi-upload-network"
        :value="formatBytes(data.bytesSent)"
        color="blue"
        :loading="loading"
      />
    </div>
  </div>
</template>

<style scoped>
.db-dashboard {
  padding: 12px;
  height: 100%;
  overflow-y: auto;
}

.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

.header-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.db-type {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.version {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  background: rgba(0, 240, 255, 0.08);
  padding: 1px 6px;
  border-radius: 3px;
}

.refresh-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.2s;
}

.refresh-btn:hover {
  background: rgba(0, 240, 255, 0.08);
  border-color: var(--cyan);
  color: var(--cyan);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
</style>
