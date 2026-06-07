<script setup lang="ts">
/**
 * SSH 服务器仪表盘
 * 展示服务器基本信息和资源使用情况
 */
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import DashboardCard from './DashboardCard.vue'

const props = defineProps<{
  sessionId: string
  connected: boolean
}>()

// 仪表盘数据
const loading = ref(true)
const refreshing = ref(false)
const data = ref({
  hostname: '--',
  os: '--',
  uptime: '--',
  load1: 0,
  load5: 0,
  load15: 0,
  cpuCores: 0,
  cpuUsage: 0,
  memTotal: 0,
  memUsed: 0,
  memFree: 0,
  swapTotal: 0,
  swapUsed: 0,
  diskTotal: 0,
  diskUsed: 0,
  diskFree: 0,
  netRx: 0,
  netTx: 0,
  processes: 0,
  users: 0
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

// 内存使用率
const memUsage = computed(() => {
  if (data.value.memTotal === 0) return 0
  return (data.value.memUsed / data.value.memTotal) * 100
})

// 磁盘使用率
const diskUsage = computed(() => {
  if (data.value.diskTotal === 0) return 0
  return (data.value.diskUsed / data.value.diskTotal) * 100
})

// 内存副标题
const memSubtitle = computed(() => {
  return `${formatBytes(data.value.memUsed)} / ${formatBytes(data.value.memTotal)}`
})

// 磁盘副标题
const diskSubtitle = computed(() => {
  return `${formatBytes(data.value.diskUsed)} / ${formatBytes(data.value.diskTotal)}`
})

// 模拟数据加载（实际项目中应通过 SSH 执行命令获取）
function loadMockData(silent = false) {
  if (!silent) {
    loading.value = true
  } else {
    refreshing.value = true
  }
  setTimeout(() => {
    data.value = {
      hostname: 'prod-server-01',
      os: 'Linux 5.15.0 Ubuntu',
      uptime: '15天 8小时',
      load1: 1.25,
      load5: 0.98,
      load15: 0.76,
      cpuCores: 4,
      cpuUsage: 32.5,
      memTotal: 8 * 1024 * 1024 * 1024,
      memUsed: 5.2 * 1024 * 1024 * 1024,
      memFree: 2.8 * 1024 * 1024 * 1024,
      swapTotal: 2 * 1024 * 1024 * 1024,
      swapUsed: 256 * 1024 * 1024,
      diskTotal: 100 * 1024 * 1024 * 1024,
      diskUsed: 62 * 1024 * 1024 * 1024,
      diskFree: 38 * 1024 * 1024 * 1024,
      netRx: 1.2 * 1024 * 1024 * 1024,
      netTx: 450 * 1024 * 1024,
      processes: 186,
      users: 3
    }
    loading.value = false
    refreshing.value = false
  }, silent ? 300 : 800)
}

// 刷新数据（无感知）
function refresh() {
  loadMockData(true)
}

// 自动刷新定时器
let refreshTimer: number | null = null

onMounted(() => {
  loadMockData()
  // 每 30 秒刷新一次
  refreshTimer = window.setInterval(refresh, 30000)
})

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
})
</script>

<template>
  <div class="ssh-dashboard">
    <div class="dashboard-header">
      <div class="header-info">
        <v-icon size="16" color="cyan">mdi-server</v-icon>
        <span class="hostname">{{ data.hostname }}</span>
        <span class="os">{{ data.os }}</span>
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

      <!-- 负载 -->
      <DashboardCard
        title="系统负载"
        icon="mdi-speedometer"
        :value="data.load1.toFixed(2)"
        :subtitle="`${data.load5.toFixed(2)} / ${data.load15.toFixed(2)}`"
        color="green"
        :loading="loading"
      />

      <!-- CPU -->
      <DashboardCard
        title="CPU 使用率"
        icon="mdi-cpu-64-bit"
        :value="data.cpuUsage.toFixed(1) + '%'"
        :subtitle="`${data.cpuCores} 核心`"
        :progress="data.cpuUsage"
        color="cyan"
        :loading="loading"
      />

      <!-- 内存 -->
      <DashboardCard
        title="内存使用"
        icon="mdi-memory"
        :value="memUsage.toFixed(1) + '%'"
        :subtitle="memSubtitle"
        :progress="memUsage"
        :color="memUsage > 80 ? 'red' : memUsage > 60 ? 'yellow' : 'green'"
        :loading="loading"
      />

      <!-- 磁盘 -->
      <DashboardCard
        title="磁盘使用"
        icon="mdi-harddisk"
        :value="diskUsage.toFixed(1) + '%'"
        :subtitle="diskSubtitle"
        :progress="diskUsage"
        :color="diskUsage > 90 ? 'red' : diskUsage > 70 ? 'yellow' : 'cyan'"
        :loading="loading"
      />

      <!-- 进程数 -->
      <DashboardCard
        title="进程数"
        icon="mdi-application-cog"
        :value="data.processes"
        color="purple"
        :loading="loading"
      />

      <!-- 网络接收 -->
      <DashboardCard
        title="网络接收"
        icon="mdi-download-network"
        :value="formatBytes(data.netRx)"
        color="blue"
        :loading="loading"
      />

      <!-- 网络发送 -->
      <DashboardCard
        title="网络发送"
        icon="mdi-upload-network"
        :value="formatBytes(data.netTx)"
        color="blue"
        :loading="loading"
      />
    </div>
  </div>
</template>

<style scoped>
.ssh-dashboard {
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

.hostname {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.os {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
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
