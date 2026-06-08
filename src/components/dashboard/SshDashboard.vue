<script setup lang="ts">
/**
 * SSH 服务器仪表盘
 * 全部数据来自 ssh_exec 真实命令采集,无任何 mock。
 */
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, computed, watch } from 'vue'
import DashboardCard from './DashboardCard.vue'
import { sshExec } from '@/services/ssh'
import {
  parseMemInfo,
  parseLoad,
  parseDf,
  parseSystemInfo,
  parseUptime,
  formatBytes,
  formatUptime,
  type SshMemInfo,
  type SshLoadInfo,
  type SshDiskInfo,
  type SshSystemInfo,
  type SshUptimeInfo,
} from '@/utils/sshMetrics'

const props = defineProps<{
  sessionId: string
  connected: boolean
}>()

const loading = ref(true)
const refreshing = ref(false)
const error = ref<string | null>(null)

const mem = ref<SshMemInfo>({
  total: 0, free: 0, available: 0, buffers: 0, cached: 0,
  swapTotal: 0, swapFree: 0,
})
const load = ref<SshLoadInfo>({ load1: 0, load5: 0, load15: 0, cpuCores: 0 })
const disk = ref<SshDiskInfo>({ total: 0, used: 0, free: 0, mountpoint: '/', entries: [] })
const system = ref<SshSystemInfo>({ hostname: '--', kernel: '--', arch: '--', osPretty: '--' })
const uptime = ref<SshUptimeInfo>({ seconds: 0, pretty: '--' })

// 内存使用率(available 比 free 更准确反映"可分配给新进程")
const memUsed = computed(() => Math.max(0, mem.value.total - mem.value.available))
const memUsage = computed(() => mem.value.total > 0 ? (memUsed.value / mem.value.total) * 100 : 0)
const memSubtitle = computed(() => `${formatBytes(memUsed.value)} / ${formatBytes(mem.value.total)}`)

// 磁盘使用率
const diskUsage = computed(() => disk.value.total > 0 ? (disk.value.used / disk.value.total) * 100 : 0)
const diskSubtitle = computed(() => `${formatBytes(disk.value.used)} / ${formatBytes(disk.value.total)}`)

// CPU 使用率(用 1 分钟负载 / 核心数,1 分钟负载 < 核心数表示健康)
const cpuUsage = computed(() => {
  if (load.value.cpuCores <= 0) return 0
  return Math.min(100, (load.value.load1 / load.value.cpuCores) * 100)
})

/** 用 Promise.all 并发跑所有采集命令,谁先报错就显示 error,但仍展示已收到的部分 */
async function loadAll() {
  if (!props.sessionId) return
  if (!props.connected) {
    loading.value = false
    return
  }
  try {
    const results = await Promise.allSettled([
      sshExec(props.sessionId, 'cat /proc/meminfo', 5),
      sshExec(props.sessionId, 'cat /proc/loadavg', 5),
      sshExec(props.sessionId, 'nproc', 5),
      sshExec(props.sessionId, 'df -P -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs', 5),
      sshExec(props.sessionId, 'uname -a', 5),
      sshExec(props.sessionId, 'hostname', 5),
      sshExec(props.sessionId, 'cat /proc/uptime', 5),
    ])

    const [rMem, rLoad, rNproc, rDf, rUname, rHost, rUp] = results

    // 任意一条挂了就把错误记下来,其他能解析的照样用
    const firstErr = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
    if (firstErr) {
      error.value = String(firstErr.reason ?? '').slice(0, 200)
    } else {
      error.value = null
    }

    if (rMem.status === 'fulfilled') mem.value = parseMemInfo(rMem.value)
    if (rLoad.status === 'fulfilled' && rNproc.status === 'fulfilled') {
      load.value = parseLoad(rLoad.value, rNproc.value)
    }
    if (rDf.status === 'fulfilled') disk.value = parseDf(rDf.value)
    if (rUname.status === 'fulfilled' && rHost.status === 'fulfilled') {
      system.value = parseSystemInfo(rUname.value, rHost.value)
    }
    if (rUp.status === 'fulfilled') uptime.value = parseUptime(rUp.value)
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

function startTimer() {
  stopTimer()
  refreshTimer = window.setInterval(() => {
    if (props.connected) refresh()
  }, 30000)
}

function stopTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

onMounted(() => {
  loadAll()
  startTimer()
})

onBeforeUnmount(() => {
  stopTimer()
})

// <KeepAlive> 失活时暂停定时器(节省资源),激活时恢复
onDeactivated(() => {
  stopTimer()
})

onActivated(() => {
  startTimer()
})

// session 变化 / 重连时重新拉
watch(() => [props.sessionId, props.connected], ([id, conn], [oldId, oldConn]) => {
  if (id !== oldId || (conn && !oldConn)) {
    loading.value = true
    loadAll()
  }
})
</script>

<template>
  <div class="ssh-dashboard">
    <div class="dashboard-header">
      <div class="header-info">
        <v-icon size="16" color="cyan">mdi-server</v-icon>
        <span class="hostname">{{ system.hostname }}</span>
        <span class="os">{{ system.osPretty }} · {{ system.arch }}</span>
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
      <span>SSH 未连接,等待连接后自动采集</span>
    </div>

    <div class="dashboard-grid">
      <DashboardCard
        title="运行时间"
        icon="mdi-clock-outline"
        :value="uptime.pretty"
        :subtitle="`${uptime.seconds} 秒`"
        color="cyan"
        :loading="loading"
      />

      <DashboardCard
        title="系统负载"
        icon="mdi-speedometer"
        :value="load.load1.toFixed(2)"
        :subtitle="`5m ${load.load5.toFixed(2)} · 15m ${load.load15.toFixed(2)}`"
        color="green"
        :loading="loading"
      />

      <DashboardCard
        title="CPU 使用率"
        icon="mdi-cpu-64-bit"
        :value="cpuUsage.toFixed(1) + '%'"
        :subtitle="`${load.cpuCores} 核心`"
        :progress="cpuUsage"
        :color="cpuUsage > 80 ? 'red' : cpuUsage > 50 ? 'yellow' : 'cyan'"
        :loading="loading"
      />

      <DashboardCard
        title="内存使用"
        icon="mdi-memory"
        :value="memUsage.toFixed(1) + '%'"
        :subtitle="memSubtitle"
        :progress="memUsage"
        :color="memUsage > 80 ? 'red' : memUsage > 60 ? 'yellow' : 'green'"
        :loading="loading"
      />

      <DashboardCard
        title="磁盘使用"
        icon="mdi-harddisk"
        :value="diskUsage.toFixed(1) + '%'"
        :subtitle="disk.mountpoint"
        :progress="diskUsage"
        :color="diskUsage > 90 ? 'red' : diskUsage > 70 ? 'yellow' : 'cyan'"
        :loading="loading"
      />

      <DashboardCard
        title="可用内存"
        icon="mdi-memory"
        :value="formatBytes(mem.available)"
        color="cyan"
        :loading="loading"
      />

      <DashboardCard
        title="Swap 使用"
        icon="mdi-swap-horizontal"
        :value="formatBytes(mem.swapTotal - mem.swapFree)"
        :subtitle="`总 ${formatBytes(mem.swapTotal)}`"
        :progress="mem.swapTotal > 0 ? ((mem.swapTotal - mem.swapFree) / mem.swapTotal) * 100 : 0"
        :color="(mem.swapTotal - mem.swapFree) / Math.max(1, mem.swapTotal) > 0.3 ? 'red' : 'green'"
        :loading="loading"
      />

      <DashboardCard
        title="磁盘总数"
        icon="mdi-harddisk"
        :value="formatBytes(disk.total)"
        :subtitle="`空闲 ${formatBytes(disk.free)}`"
        color="purple"
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

.hostname {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
}

.os {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
