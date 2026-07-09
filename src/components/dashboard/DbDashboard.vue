<script setup lang="ts">
/**
 * 数据库仪表盘
 * - Redis: 走 redisInfo + redisDBSize 真实 RPC
 * - MySQL: 跑 SHOW GLOBAL STATUS / SHOW GLOBAL VARIABLES / information_schema 真实 SQL
 * 无任何 mock。
 */
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import DashboardCard from './DashboardCard.vue'
import { redisInfo, redisDBSize, mysqlExecute } from '@/services/db'
import {
  parseRedisInfo,
  parseMysqlMetrics,
  formatDbBytes,
  formatDbUptime,
  type RedisMetrics,
  type MysqlMetrics,
} from '@/utils/dbMetrics'

const props = defineProps<{
  connId: string
  dbType: string
  connected: boolean
  database?: string
}>()

const loading = ref(true)
const refreshing = ref(false)
const error = ref<string | null>(null)

const redis = ref<RedisMetrics>({
  version: '--', uptimeSeconds: 0, uptimePretty: '--',
  connectedClients: 0, connectedSlaves: 0, usedMemory: 0, usedMemoryPeak: 0,
  usedMemoryHuman: '0B', totalKeys: 0, hitRate: 0,
  totalCommandsProcessed: 0, instantaneousOpsPerSec: 0, role: '--',
  maxmemory: 0, raw: '',
})
const mysql = ref<MysqlMetrics>({
  version: '--', uptimeSeconds: 0, uptimePretty: '--',
  threadsConnected: 0, threadsRunning: 0, maxConnections: 151,
  questions: 0, slowQueries: 0, queries: 0, bytesReceived: 0, bytesSent: 0,
  innodbBufferPoolSize: 0, innodbBufferPoolUsed: 0, bufferPoolHitRate: 0,
  tableCount: 0, dataSize: 0, indexSize: 0,
})

// Redis 内存使用率(maxmemory 0 表示未设置上限,这种情况下用 usedMemoryPeak 作为参考)
const redisMemUsage = computed(() => {
  if (redis.value.maxmemory > 0) {
    return (redis.value.usedMemory / redis.value.maxmemory) * 100
  }
  return 0
})
const redisConnUsage = computed(() => {
  // Redis 默认 maxclients 10000,这里不做硬编码,直接用 connectedClients 即可
  return 0
})

// MySQL 连接使用率
const mysqlConnUsage = computed(() => {
  if (mysql.value.maxConnections === 0) return 0
  return (mysql.value.threadsConnected / mysql.value.maxConnections) * 100
})

const mysqlConnSubtitle = computed(() =>
  `${mysql.value.threadsRunning} 活跃 / ${mysql.value.maxConnections} 最大`)

const dbTypeName = computed(() => {
  switch (props.dbType) {
    case 'mysql': return 'MySQL'
    case 'postgresql': return 'PostgreSQL'
    case 'redis': return 'Redis'
    case 'sqlite': return 'SQLite'
    default: return props.dbType.toUpperCase()
  }
})

async function loadRedis() {
  // info all 返回所有 section
  const [info, dbSizeResult] = await Promise.allSettled([
    redisInfo(props.connId, 'all'),
    redisDBSize(props.connId),
  ])
  if (info.status !== 'fulfilled') {
    throw info.reason
  }
  const dbSize = dbSizeResult.status === 'fulfilled' ? dbSizeResult.value?.size : undefined
  redis.value = parseRedisInfo(info.value, dbSize)
}

async function loadMysql() {
  // 跑 status + variables + table count + size sum
  const [status, variables, tableStats, sizeStats] = await Promise.allSettled([
    mysqlExecute(props.connId, 'SHOW GLOBAL STATUS', props.database || undefined),
    mysqlExecute(props.connId, 'SHOW GLOBAL VARIABLES', props.database || undefined),
    mysqlExecute(
      props.connId,
      `SELECT COUNT(*) AS table_count FROM information_schema.tables
       WHERE table_schema = DATABASE()`,
      props.database || undefined,
    ),
    mysqlExecute(
      props.connId,
      `SELECT COALESCE(SUM(data_length), 0) AS data_size,
              COALESCE(SUM(index_length), 0) AS index_size
       FROM information_schema.tables WHERE table_schema = DATABASE()`,
      props.database || undefined,
    ),
  ])
  if (status.status !== 'fulfilled') throw status.reason
  if (variables.status !== 'fulfilled') throw variables.reason
  mysql.value = parseMysqlMetrics({
    status: status.value,
    variables: variables.value,
    tableStats: tableStats.status === 'fulfilled' ? tableStats.value : undefined,
    sizeStats: sizeStats.status === 'fulfilled' ? sizeStats.value : undefined,
  })
}

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
    if (props.dbType === 'redis') {
      await loadRedis()
    } else {
      // 暂支持 MySQL,其他类型走通用 fallback
      if (props.dbType === 'mysql') {
        await loadMysql()
      } else {
        throw new Error(`仪表盘暂未支持 ${props.dbType}`)
      }
    }
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

watch(() => [props.connId, props.dbType, props.connected, props.database], () => {
  loading.value = true
  loadAll()
})
</script>

<template>
  <div class="db-dashboard">
    <div class="dashboard-header">
      <div class="header-info">
        <v-icon size="16" color="purple">mdi-database</v-icon>
        <span class="db-type">{{ dbTypeName }}</span>
        <span class="version">v{{ dbType === 'redis' ? redis.version : mysql.version }}</span>
        <span v-if="database" class="version">{{ database }}</span>
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
      <span>数据库未连接,等待连接后自动采集</span>
    </div>

    <!-- Redis 真实指标 -->
    <template v-if="dbType === 'redis'">
      <div class="dashboard-grid">
        <DashboardCard
          title="运行时间"
          icon="mdi-clock-outline"
          :value="redis.uptimePretty"
          :subtitle="`${redis.uptimeSeconds} 秒`"
          color="cyan"
          :loading="loading"
          description="MySQL 服务自启动以来的持续运行时间。"
        />

        <DashboardCard
          title="已用内存"
          icon="mdi-memory"
          :value="redis.usedMemoryHuman"
          :subtitle="redis.maxmemory > 0 ? `上限 ${formatDbBytes(redis.maxmemory)}` : '未设置上限'"
          :progress="redisMemUsage"
          :color="redisMemUsage > 80 ? 'red' : redisMemUsage > 60 ? 'yellow' : 'green'"
          :loading="loading"
          description="当前客户端连接数及正在执行语句的活跃线程数。"
        />

        <DashboardCard
          title="总键数"
          icon="mdi-key"
          :value="redis.totalKeys"
          color="cyan"
          :loading="loading"
        />

        <DashboardCard
          title="客户端连接"
          icon="mdi-connection"
          :value="redis.connectedClients"
          :subtitle="`${redis.connectedSlaves} 从节点`"
          color="purple"
          :loading="loading"
        />

        <DashboardCard
          title="命中率"
          icon="mdi-target"
          :value="redis.hitRate.toFixed(2) + '%'"
          subtitle="keyspace_hits/(hits+misses)"
          :progress="redis.hitRate"
          :color="redis.hitRate >= 95 ? 'green' : redis.hitRate >= 80 ? 'cyan' : 'red'"
          :loading="loading"
        />

        <DashboardCard
          title="峰值内存"
          icon="mdi-chart-areaspline"
          :value="formatDbBytes(redis.usedMemoryPeak)"
          color="yellow"
          :loading="loading"
        />

        <DashboardCard
          title="累计命令数"
          icon="mdi-console"
          :value="redis.totalCommandsProcessed.toLocaleString()"
          color="cyan"
          :loading="loading"
        />

        <DashboardCard
          title="每秒操作数"
          icon="mdi-flash"
          :value="redis.instantaneousOpsPerSec"
          subtitle="instantaneous_ops_per_sec"
          color="green"
          :loading="loading"
        />
      </div>
    </template>

    <!-- MySQL 真实指标 -->
    <template v-else-if="dbType === 'mysql'">
      <div class="dashboard-grid">
        <DashboardCard
          title="运行时间"
          icon="mdi-clock-outline"
          :value="mysql.uptimePretty"
          :subtitle="`${mysql.uptimeSeconds} 秒`"
          color="cyan"
          :loading="loading"
        />

        <DashboardCard
          title="连接数"
          icon="mdi-connection"
          :value="mysql.threadsConnected"
          :subtitle="mysqlConnSubtitle"
          :progress="mysqlConnUsage"
          :color="mysqlConnUsage > 80 ? 'red' : mysqlConnUsage > 50 ? 'yellow' : 'green'"
          :loading="loading"
        />

        <DashboardCard
          title="累计查询"
          icon="mdi-database-search"
          :value="mysql.queries.toLocaleString()"
          :subtitle="`Questions ${mysql.questions.toLocaleString()}`"
          color="cyan"
          :loading="loading"
          description="Queries 包含服务端执行的全部语句；Questions 更接近客户端发起的语句数量。"
        />

        <DashboardCard
          title="慢查询"
          icon="mdi-turtle"
          :value="mysql.slowQueries"
          :color="mysql.slowQueries > 100 ? 'red' : mysql.slowQueries > 10 ? 'yellow' : 'green'"
          :loading="loading"
          description="Slow_queries 累计值；需要结合 long_query_time 与慢日志进一步定位。"
        />

        <DashboardCard
          title="缓冲池命中率"
          icon="mdi-buffer"
          :value="mysql.bufferPoolHitRate.toFixed(2) + '%'"
          :subtitle="`使用 ${formatDbBytes(mysql.innodbBufferPoolUsed)} / ${formatDbBytes(mysql.innodbBufferPoolSize)}`"
          :progress="mysql.bufferPoolHitRate"
          :color="mysql.bufferPoolHitRate >= 99 ? 'green' : mysql.bufferPoolHitRate >= 95 ? 'cyan' : 'red'"
          :loading="loading"
          description="根据 InnoDB 逻辑读请求与物理读计算，越接近 100% 越好。"
        />

        <DashboardCard
          title="数据大小"
          icon="mdi-database-arrow-down"
          :value="formatDbBytes(mysql.dataSize)"
          :subtitle="`索引 ${formatDbBytes(mysql.indexSize)}`"
          color="blue"
          :loading="loading"
          :description="database ? `当前数据库 ${database} 的表数据与索引占用。` : '请先选择数据库后查看准确容量。'"
        />

        <DashboardCard
          title="表数量"
          icon="mdi-table"
          :value="mysql.tableCount"
          color="cyan"
          :loading="loading"
          :description="database ? `当前数据库 ${database} 的基础表与视图数量。` : '请先选择数据库后查看准确表数量。'"
        />

        <DashboardCard
          title="活跃线程"
          icon="mdi-application-cog"
          :value="mysql.threadsRunning"
          :subtitle="`${mysql.threadsConnected} 已连接`"
          color="green"
          :loading="loading"
        />

        <DashboardCard
          title="网络接收"
          icon="mdi-download-network"
          :value="formatDbBytes(mysql.bytesReceived)"
          color="blue"
          :loading="loading"
        />

        <DashboardCard
          title="网络发送"
          icon="mdi-upload-network"
          :value="formatDbBytes(mysql.bytesSent)"
          color="blue"
          :loading="loading"
        />
      </div>
    </template>

    <!-- 其他数据库类型,等待支持 -->
    <template v-else>
      <div class="unsupported">
        <v-icon size="32" color="muted">mdi-database-off-outline</v-icon>
        <p>仪表盘暂未支持 {{ dbTypeName }},请先用 SQL 编辑器查询</p>
      </div>
    </template>
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
  margin-bottom: 12px;
  padding-bottom: 10px;
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
  background: var(--hover-cyan);
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
  background: var(--hover-cyan);
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
  background: var(--status-error-bg);
  border-color: var(--status-error-border);
}

.hint-banner {
  color: var(--muted);
  background: var(--hover-cyan-faint);
  border-color: var(--line-2);
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.unsupported {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 16px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
