<script setup lang="ts">
/**
 * Docker 仪表盘
 * 展示 Docker 环境信息和资源使用
 */
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import DashboardCard from './DashboardCard.vue'

const props = defineProps<{
  connId: string
  connected: boolean
}>()

// 仪表盘数据
const loading = ref(true)
const refreshing = ref(false)
const data = ref({
  version: '--',
  apiVersion: '--',
  os: '--',
  arch: '--',
  containers: 0,
  containersRunning: 0,
  containersPaused: 0,
  containersStopped: 0,
  images: 0,
  volumes: 0,
  networks: 0,
  cpuTotal: 0,
  memTotal: 0,
  memUsed: 0,
  diskTotal: 0,
  diskUsed: 0,
  layersSize: 0
})

// 格式化字节
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

// 容器运行率
const containerRunningRate = computed(() => {
  if (data.value.containers === 0) return 0
  return (data.value.containersRunning / data.value.containers) * 100
})

// 容器副标题
const containerSubtitle = computed(() => {
  const parts = []
  if (data.value.containersRunning > 0) parts.push(`${data.value.containersRunning} 运行中`)
  if (data.value.containersPaused > 0) parts.push(`${data.value.containersPaused} 暂停`)
  if (data.value.containersStopped > 0) parts.push(`${data.value.containersStopped} 已停止`)
  return parts.join(' · ') || '无容器'
})

// 磁盘使用率
const diskUsage = computed(() => {
  if (data.value.diskTotal === 0) return 0
  return (data.value.diskUsed / data.value.diskTotal) * 100
})

// 磁盘副标题
const diskSubtitle = computed(() => {
  return `${formatBytes(data.value.diskUsed)} / ${formatBytes(data.value.diskTotal)}`
})

// 容器颜色状态
const containerColor = computed(() => {
  if (data.value.containersRunning === 0) return 'cyan'
  if (data.value.containersStopped > 0) return 'yellow'
  return 'green'
})

// 模拟数据
function loadMockData(silent = false) {
  if (!silent) {
    loading.value = true
  } else {
    refreshing.value = true
  }
  setTimeout(() => {
    data.value = {
      version: '24.0.7',
      apiVersion: '1.43',
      os: 'Linux',
      arch: 'x86_64',
      containers: 12,
      containersRunning: 8,
      containersPaused: 1,
      containersStopped: 3,
      images: 25,
      volumes: 18,
      networks: 6,
      cpuTotal: 8,
      memTotal: 16 * 1024 * 1024 * 1024,
      memUsed: 8.5 * 1024 * 1024 * 1024,
      diskTotal: 200 * 1024 * 1024 * 1024,
      diskUsed: 85 * 1024 * 1024 * 1024,
      layersSize: 12.5 * 1024 * 1024 * 1024
    }
    loading.value = false
    refreshing.value = false
  }, silent ? 300 : 700)
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
  <div class="docker-dashboard">
    <div class="dashboard-header">
      <div class="header-info">
        <v-icon size="16" color="green">mdi-docker</v-icon>
        <span class="docker-engine">Docker Engine</span>
        <span class="version">v{{ data.version }}</span>
      </div>
      <button class="refresh-btn" @click="refresh" :disabled="loading">
        <v-icon size="14" :class="{ spinning: loading }">mdi-refresh</v-icon>
      </button>
    </div>

    <div class="dashboard-grid">
      <!-- 容器总数 -->
      <DashboardCard
        title="容器"
        icon="mdi-cube-outline"
        :value="data.containers"
        :subtitle="containerSubtitle"
        :progress="containerRunningRate"
        :color="containerColor"
        :loading="loading"
      />

      <!-- 运行中 -->
      <DashboardCard
        title="运行中"
        icon="mdi-play-circle-outline"
        :value="data.containersRunning"
        color="green"
        :loading="loading"
      />

      <!-- 镜像 -->
      <DashboardCard
        title="镜像"
        icon="mdi-disc"
        :value="data.images"
        :subtitle="formatBytes(data.layersSize)"
        color="cyan"
        :loading="loading"
      />

      <!-- 卷 -->
      <DashboardCard
        title="卷"
        icon="mdi-database-outline"
        :value="data.volumes"
        color="purple"
        :loading="loading"
      />

      <!-- 网络 -->
      <DashboardCard
        title="网络"
        icon="mdi-lan"
        :value="data.networks"
        color="blue"
        :loading="loading"
      />

      <!-- 磁盘使用 -->
      <DashboardCard
        title="磁盘使用"
        icon="mdi-harddisk"
        :value="diskUsage.toFixed(1) + '%'"
        :subtitle="diskSubtitle"
        :progress="diskUsage"
        :color="diskUsage > 80 ? 'red' : diskUsage > 60 ? 'yellow' : 'cyan'"
        :loading="loading"
      />

      <!-- CPU -->
      <DashboardCard
        title="CPU 核心"
        icon="mdi-cpu-64-bit"
        :value="data.cpuTotal"
        color="cyan"
        :loading="loading"
      />

      <!-- 内存 -->
      <DashboardCard
        title="总内存"
        icon="mdi-memory"
        :value="formatBytes(data.memTotal)"
        color="green"
        :loading="loading"
      />
    </div>
  </div>
</template>

<style scoped>
.docker-dashboard {
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

.docker-engine {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.version {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  background: rgba(0, 255, 136, 0.08);
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
