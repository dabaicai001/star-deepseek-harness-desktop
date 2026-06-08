<script setup lang="ts">
/**
 * Docker 仪表盘
 * 数据全部来自 docker_list_containers / docker_list_images 真实 RPC,无 mock。
 */
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import DashboardCard from './DashboardCard.vue'
import { listContainers, listImages } from '@/services/docker'
import { formatBytes } from '@/utils/sshMetrics'
import type { ContainerInfo, ImageInfo } from '@/types/docker'

const props = defineProps<{
  connId: string
  connected: boolean
}>()

const loading = ref(true)
const refreshing = ref(false)
const error = ref<string | null>(null)
const containers = ref<ContainerInfo[]>([])
const images = ref<ImageInfo[]>([])

const runningCount = computed(() => containers.value.filter(c => c.state === 'running').length)
const pausedCount = computed(() => containers.value.filter(c => c.state === 'paused').length)
const stoppedCount = computed(() => containers.value.filter(c => c.state !== 'running' && c.state !== 'paused').length)
const total = computed(() => containers.value.length)
const runningRate = computed(() => total.value > 0 ? (runningCount.value / total.value) * 100 : 0)
const containerSubtitle = computed(() => {
  const parts: string[] = []
  if (runningCount.value > 0) parts.push(`${runningCount.value} 运行中`)
  if (pausedCount.value > 0) parts.push(`${pausedCount.value} 暂停`)
  if (stoppedCount.value > 0) parts.push(`${stoppedCount.value} 已停止`)
  return parts.join(' · ') || '无容器'
})
const containerColor = computed(() => {
  if (total.value === 0) return 'cyan'
  if (stoppedCount.value > 0 && runningCount.value > 0) return 'yellow'
  if (runningCount.value === 0) return 'red'
  return 'green'
})

// 镜像总大小(累加,VirtualSize 字段不一定有,fallback 到 size)
const imagesSize = computed(() => images.value.reduce((s, img) => s + (img.size || 0), 0))
const imagesSizePretty = computed(() => formatBytes(imagesSize.value))

// 网络 / 卷 / 端口 (从第一个运行中容器的 ports 估一下"在用端口数")
const usedPorts = computed(() => {
  const set = new Set<string>()
  for (const c of containers.value) {
    for (const p of c.ports || []) {
      if (p.public) set.add(`${p.public}/${p.type}`)
    }
  }
  return set.size
})

async function loadAll() {
  if (!props.connId) {
    loading.value = false
    return
  }
  if (!props.connected) {
    loading.value = false
    return
  }
  try {
    const [cs, imgs] = await Promise.all([
      listContainers(props.connId, true),
      listImages(props.connId, false).catch(() => [] as ImageInfo[]),
    ])
    containers.value = cs || []
    images.value = imgs || []
    error.value = null
  } catch (e) {
    error.value = String(e ?? '').slice(0, 200)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function refresh() {
  refreshing.value = true
  loadAll()
}

let refreshTimer: number | null = null

onMounted(() => {
  loadAll()
  refreshTimer = window.setInterval(() => {
    if (props.connected) refresh()
  }, 30000)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

watch(() => [props.connId, props.connected], ([id, conn], [oldId, oldConn]) => {
  if (id !== oldId || (conn && !oldConn)) {
    loading.value = true
    loadAll()
  }
})
</script>

<template>
  <div class="docker-dashboard">
    <div class="dashboard-header">
      <div class="header-info">
        <v-icon size="16" color="green">mdi-docker</v-icon>
        <span class="docker-engine">Docker</span>
        <span class="version">{{ total }} 容器 · {{ images.length }} 镜像</span>
      </div>
      <button class="refresh-btn" @click="refresh" :disabled="loading">
        <v-icon size="14" :class="{ spinning: refreshing }">mdi-refresh</v-icon>
      </button>
    </div>

    <div v-if="error" class="error-banner">
      <v-icon size="12">mdi-alert-circle-outline</v-icon>
      <span>{{ error }}</span>
    </div>

    <div v-if="!connected" class="hint-banner">
      <v-icon size="12">mdi-information-outline</v-icon>
      <span>Docker 未连接,等待连接后自动采集</span>
    </div>

    <div class="dashboard-grid">
      <DashboardCard
        title="容器总数"
        icon="mdi-cube-outline"
        :value="total"
        :subtitle="containerSubtitle"
        :progress="runningRate"
        :color="containerColor"
        :loading="loading"
      />

      <DashboardCard
        title="运行中"
        icon="mdi-play-circle-outline"
        :value="runningCount"
        color="green"
        :loading="loading"
      />

      <DashboardCard
        title="已停止"
        icon="mdi-stop-circle-outline"
        :value="stoppedCount"
        :color="stoppedCount > 0 ? 'yellow' : 'cyan'"
        :loading="loading"
      />

      <DashboardCard
        title="暂停中"
        icon="mdi-pause-circle-outline"
        :value="pausedCount"
        color="purple"
        :loading="loading"
      />

      <DashboardCard
        title="镜像数量"
        icon="mdi-disc"
        :value="images.length"
        color="cyan"
        :loading="loading"
      />

      <DashboardCard
        title="镜像占用"
        icon="mdi-database"
        :value="imagesSizePretty"
        color="purple"
        :loading="loading"
      />

      <DashboardCard
        title="暴露端口"
        icon="mdi-lan-connect"
        :value="usedPorts"
        :subtitle="`通过 ${runningCount} 个运行中容器`"
        color="blue"
        :loading="loading"
      />

      <DashboardCard
        title="健康率"
        icon="mdi-heart-pulse"
        :value="runningRate.toFixed(0) + '%'"
        :subtitle="`${runningCount}/${total} 容器运行中`"
        :progress="runningRate"
        :color="runningRate === 100 ? 'green' : runningRate >= 50 ? 'cyan' : 'yellow'"
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
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}

.header-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
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
  background: rgba(74, 222, 128, 0.08);
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
  flex-shrink: 0;
}

.refresh-btn:hover {
  background: rgba(0, 240, 255, 0.08);
  border-color: var(--green);
  color: var(--green);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

.error-banner,
.hint-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  padding: 6px 10px;
  border-radius: 4px;
  margin-bottom: 10px;
  border: 1px solid;
}

.error-banner {
  color: var(--red);
  background: rgba(255, 77, 109, 0.05);
  border-color: rgba(255, 77, 109, 0.2);
}

.hint-banner {
  color: var(--muted);
  background: rgba(120, 160, 255, 0.04);
  border-color: var(--line-2);
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
