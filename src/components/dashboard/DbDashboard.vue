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
  parseMysqlProcessDetails,
  parseMysqlSlowQueryDetails,
  queryRowsToRecords,
  formatDbBytes,
  formatDbUptime,
  type RedisMetrics,
  type MysqlMetrics,
  type MysqlProcessDetail,
  type MysqlSlowQueryDetail,
} from '@/utils/dbMetrics'
import type { DashboardDetailTable } from './DashboardCard.vue'

const props = defineProps<{
  connId: string
  dbType: string
  connected: boolean
  database?: string
}>()

const loading = ref(true)
const refreshing = ref(false)
const error = ref<string | null>(null)
const sampleKey = ref(0)
const mysqlProcesses = ref<MysqlProcessDetail[]>([])
const mysqlSlowQueries = ref<MysqlSlowQueryDetail[]>([])
const mysqlSlowDetailHint = ref('慢日志未开启、暂无记录，或当前账号无权读取 mysql.slow_log。')
const postgres = ref({
  version: '--',
  uptimeSeconds: 0,
  connections: 0,
  activeConnections: 0,
  maxConnections: 100,
  databaseSize: 0,
  cacheHitRate: 0,
  tableCount: 0,
  transactions: 0,
})
type DetailRecord = Record<string, string | number | null | undefined>
const postgresSessions = ref<DetailRecord[]>([])
const postgresSlowStatements = ref<DetailRecord[]>([])

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
const mysqlDataRatio = computed(() => {
  const total = mysql.value.dataSize + mysql.value.indexSize
  return total > 0 ? (mysql.value.dataSize / total) * 100 : 0
})
const mysqlConnectionTable = computed<DashboardDetailTable>(() => ({
  columns: [
    { key: 'ip', label: '客户端 IP' },
    { key: 'user', label: '用户' },
    { key: 'database', label: '数据库' },
    { key: 'command', label: '命令' },
    { key: 'time', label: '持续(s)', align: 'right' },
    { key: 'state', label: '状态' },
    { key: 'sql', label: '当前 SQL', wide: true },
  ],
  rows: mysqlProcesses.value.map(process => ({
    ip: process.ip,
    user: process.user,
    database: process.database,
    command: process.command,
    time: process.timeSeconds,
    state: process.state,
    sql: process.sql,
  })),
  emptyText: '当前没有其他连接；无 PROCESS 权限时 MySQL 只返回本账号会话。',
}))
const mysqlSlowQueryTable = computed<DashboardDetailTable>(() => ({
  columns: [
    { key: 'startedAt', label: '发生时间' },
    { key: 'duration', label: '耗时' },
    { key: 'database', label: '数据库' },
    { key: 'userHost', label: '用户 / IP' },
    { key: 'rowsExamined', label: '扫描行', align: 'right' },
    { key: 'executions', label: '次数', align: 'right' },
    { key: 'sql', label: '慢 SQL 语句', wide: true },
  ],
  rows: mysqlSlowQueries.value.map(query => ({
    startedAt: query.startedAt,
    duration: query.duration,
    database: query.database,
    userHost: query.userHost,
    rowsExamined: query.rowsExamined,
    executions: query.executions ?? 1,
    sql: query.sql,
  })),
  emptyText: mysqlSlowDetailHint.value,
}))
const postgresConnectionUsage = computed(() => (
  postgres.value.maxConnections > 0
    ? postgres.value.connections / postgres.value.maxConnections * 100
    : 0
))
const postgresConnectionTable = computed<DashboardDetailTable>(() => ({
  columns: [
    { key: 'ip', label: '客户端 IP' },
    { key: 'user', label: '用户' },
    { key: 'database', label: '数据库' },
    { key: 'application', label: '应用' },
    { key: 'state', label: '状态' },
    { key: 'duration', label: '持续(s)', align: 'right' },
    { key: 'wait', label: '等待事件' },
    { key: 'sql', label: '当前 SQL', wide: true },
  ],
  rows: postgresSessions.value,
  emptyText: '当前没有其他 PostgreSQL 会话，或当前账号无权读取 pg_stat_activity。',
}))
const postgresSlowQueryTable = computed<DashboardDetailTable>(() => ({
  columns: [
    { key: 'duration', label: '累计/当前耗时' },
    { key: 'calls', label: '次数', align: 'right' },
    { key: 'rows', label: '返回行', align: 'right' },
    { key: 'user', label: '用户' },
    { key: 'database', label: '数据库' },
    { key: 'ip', label: '客户端 IP' },
    { key: 'sql', label: 'SQL 语句', wide: true },
  ],
  rows: postgresSlowStatements.value,
  emptyText: '暂无慢语句；安装 pg_stat_statements 可查看历史聚合，否则仅展示当前运行超过 1 秒的语句。',
}))

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
  // 汇总指标和当前连接并发采集；进程列表权限不足不影响其他指标。
  const [status, variables, tableStats, sizeStats, processList] = await Promise.allSettled([
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
    mysqlExecute(
      props.connId,
      `SELECT ID AS id, USER AS user, HOST AS host, DB AS db,
              COMMAND AS command, TIME AS time, STATE AS state,
              LEFT(INFO, 2000) AS info
       FROM information_schema.PROCESSLIST
       WHERE ID <> CONNECTION_ID()
       ORDER BY (COMMAND = 'Sleep') ASC, TIME DESC
       LIMIT 100`,
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
  mysqlProcesses.value = processList.status === 'fulfilled'
    ? parseMysqlProcessDetails(processList.value)
    : []

  // 精确慢 SQL 优先读 TABLE 慢日志；未开启/无权限时回退到
  // performance_schema digest，至少给出可定位的归一化 SQL 与累计耗时。
  try {
    const slowLog = await mysqlExecute(
      props.connId,
      `SELECT DATE_FORMAT(start_time, '%Y-%m-%d %H:%i:%s') AS started_at,
              CAST(query_time AS CHAR) AS duration,
              CAST(lock_time AS CHAR) AS lock_time,
              rows_examined, db, user_host, LEFT(sql_text, 4000) AS sql_text
       FROM mysql.slow_log
       ORDER BY start_time DESC
       LIMIT 50`,
      props.database || undefined,
    )
    mysqlSlowQueries.value = parseMysqlSlowQueryDetails(slowLog, 'slow_log')
    mysqlSlowDetailHint.value = 'mysql.slow_log 当前没有记录；请确认 slow_query_log=ON 且 log_output 包含 TABLE。'
  } catch {
    try {
      const digest = await mysqlExecute(
        props.connId,
        `SELECT DATE_FORMAT(FIRST_SEEN, '%Y-%m-%d %H:%i:%s') AS first_seen,
                CONCAT(ROUND(SUM_TIMER_WAIT / 1000000000000, 3), ' s') AS total_latency,
                COUNT_STAR AS executions,
                SUM_ROWS_EXAMINED AS rows_examined,
                SCHEMA_NAME AS db,
                LEFT(DIGEST_TEXT, 4000) AS digest_text
         FROM performance_schema.events_statements_summary_by_digest
         WHERE DIGEST_TEXT IS NOT NULL
         ORDER BY SUM_TIMER_WAIT DESC
         LIMIT 50`,
        props.database || undefined,
      )
      mysqlSlowQueries.value = parseMysqlSlowQueryDetails(digest, 'performance_schema')
      mysqlSlowDetailHint.value = 'performance_schema 当前没有语句摘要；请确认已启用 statements digest consumer。'
    } catch {
      mysqlSlowQueries.value = []
      mysqlSlowDetailHint.value = '无法读取慢日志与 performance_schema；请开启慢日志或授予对应只读权限。'
    }
  }
}

function firstRecord(result: Awaited<ReturnType<typeof mysqlExecute>>): Record<string, unknown> {
  return queryRowsToRecords(result)[0] || {}
}

function detailRecords(result: Awaited<ReturnType<typeof mysqlExecute>>): DetailRecord[] {
  return queryRowsToRecords(result).map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value === null || value === undefined || typeof value === 'string' || typeof value === 'number'
        ? value
        : String(value),
    ]),
  ))
}

async function loadPostgres() {
  const [summary, sessions] = await Promise.all([
    mysqlExecute(
      props.connId,
      `SELECT current_setting('server_version') AS version,
              EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint AS uptime_seconds,
              (SELECT count(*) FROM pg_stat_activity) AS connections,
              (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active_connections,
              current_setting('max_connections')::int AS max_connections,
              pg_database_size(current_database()) AS database_size,
              COALESCE((SELECT round(100 * sum(blks_hit)::numeric /
                NULLIF(sum(blks_hit + blks_read), 0), 2) FROM pg_stat_database), 0) AS cache_hit_rate,
              (SELECT count(*) FROM pg_stat_user_tables
                WHERE schemaname = current_schema()) AS table_count,
              COALESCE((SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database), 0) AS transactions`,
    ),
    mysqlExecute(
      props.connId,
      `SELECT COALESCE(client_addr::text, 'local') AS ip,
              COALESCE(usename, '--') AS "user",
              COALESCE(datname, '--') AS database,
              COALESCE(application_name, '--') AS application,
              COALESCE(state, '--') AS state,
              round(EXTRACT(EPOCH FROM (clock_timestamp() -
                COALESCE(query_start, backend_start)))::numeric, 2) AS duration,
              COALESCE(wait_event_type || ':' || wait_event, '--') AS wait,
              COALESCE(LEFT(query, 4000), '(空闲连接)') AS sql
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
       ORDER BY (state = 'active') DESC, query_start NULLS LAST
       LIMIT 100`,
    ),
  ])
  const row = firstRecord(summary)
  const number = (value: unknown) => {
    const parsed = Number(value ?? 0)
    return Number.isFinite(parsed) ? parsed : 0
  }
  postgres.value = {
    version: String(row.version ?? '--'),
    uptimeSeconds: number(row.uptime_seconds),
    connections: number(row.connections),
    activeConnections: number(row.active_connections),
    maxConnections: number(row.max_connections),
    databaseSize: number(row.database_size),
    cacheHitRate: number(row.cache_hit_rate),
    tableCount: number(row.table_count),
    transactions: number(row.transactions),
  }
  postgresSessions.value = detailRecords(sessions)

  try {
    const history = await mysqlExecute(
      props.connId,
      `SELECT round(total_exec_time::numeric / 1000, 3) || ' s' AS duration,
              calls, rows, '--' AS "user", current_database() AS database,
              '历史聚合' AS ip, LEFT(query, 4000) AS sql
       FROM pg_stat_statements
       WHERE query IS NOT NULL
       ORDER BY total_exec_time DESC
       LIMIT 50`,
    )
    postgresSlowStatements.value = detailRecords(history)
  } catch {
    postgresSlowStatements.value = postgresSessions.value
      .filter(row => row.state === 'active' && Number(row.duration ?? 0) >= 1)
      .map(row => ({ ...row, calls: 1, rows: '--' }))
  }
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
      } else if (props.dbType === 'postgresql') {
        await loadPostgres()
      } else {
        // 不支持的数据库类型不抛错，由模板 v-else 分支显示友好提示
        loading.value = false
        return
      }
    }
    error.value = null
    sampleKey.value += 1
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
        <span class="version">v{{ dbType === 'redis' ? redis.version : dbType === 'postgresql' ? postgres.version : mysql.version }}</span>
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
          description="Redis 服务自启动以来的持续运行时间。"
          :chart-value="redis.uptimeSeconds"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="已用内存"
          icon="mdi-memory"
          :value="redis.usedMemoryHuman"
          :subtitle="redis.maxmemory > 0 ? `上限 ${formatDbBytes(redis.maxmemory)}` : '未设置上限'"
          :progress="redisMemUsage"
          :color="redisMemUsage > 80 ? 'red' : redisMemUsage > 60 ? 'yellow' : 'green'"
          :loading="loading"
          description="Redis 当前内存占用；配置 maxmemory 后显示使用比例。"
          :chart-value="redis.usedMemory"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="总键数"
          icon="mdi-key"
          :value="redis.totalKeys"
          color="cyan"
          :loading="loading"
          :chart-value="redis.totalKeys"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="客户端连接"
          icon="mdi-connection"
          :value="redis.connectedClients"
          :subtitle="`${redis.connectedSlaves} 从节点`"
          color="purple"
          :loading="loading"
          :chart-value="redis.connectedClients"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="命中率"
          icon="mdi-target"
          :value="redis.hitRate.toFixed(2) + '%'"
          subtitle="keyspace_hits/(hits+misses)"
          :progress="redis.hitRate"
          :color="redis.hitRate >= 95 ? 'green' : redis.hitRate >= 80 ? 'cyan' : 'red'"
          :loading="loading"
          :chart-value="redis.hitRate"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="峰值内存"
          icon="mdi-chart-areaspline"
          :value="formatDbBytes(redis.usedMemoryPeak)"
          color="yellow"
          :loading="loading"
          :chart-value="redis.usedMemoryPeak"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="累计命令数"
          icon="mdi-console"
          :value="redis.totalCommandsProcessed.toLocaleString()"
          color="cyan"
          :loading="loading"
          :chart-value="redis.totalCommandsProcessed"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="每秒操作数"
          icon="mdi-flash"
          :value="redis.instantaneousOpsPerSec"
          subtitle="instantaneous_ops_per_sec"
          color="green"
          :loading="loading"
          :chart-value="redis.instantaneousOpsPerSec"
          :sample-key="sampleKey"
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
          :chart-value="mysql.uptimeSeconds"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="连接数"
          icon="mdi-connection"
          :value="mysql.threadsConnected"
          :subtitle="mysqlConnSubtitle"
          :progress="mysqlConnUsage"
          :color="mysqlConnUsage > 80 ? 'red' : mysqlConnUsage > 50 ? 'yellow' : 'green'"
          :loading="loading"
          :chart-value="mysql.threadsConnected"
          :sample-key="sampleKey"
          :detail-table="mysqlConnectionTable"
          description="当前连接占 max_connections 的比例；明细列出客户端 IP、账号、数据库、状态与正在执行的 SQL。"
        />

        <DashboardCard
          title="累计查询"
          icon="mdi-database-search"
          :value="mysql.queries.toLocaleString()"
          :subtitle="`Questions ${mysql.questions.toLocaleString()}`"
          color="cyan"
          :loading="loading"
          :chart-value="mysql.queries"
          :sample-key="sampleKey"
          description="Queries 包含服务端执行的全部语句；Questions 更接近客户端发起的语句数量。"
        />

        <DashboardCard
          title="慢查询"
          icon="mdi-turtle"
          :value="mysql.slowQueries"
          :color="mysql.slowQueries > 100 ? 'red' : mysql.slowQueries > 10 ? 'yellow' : 'green'"
          :loading="loading"
          :chart-value="mysql.slowQueries"
          :sample-key="sampleKey"
          :detail-table="mysqlSlowQueryTable"
          description="Slow_queries 累计值；下方优先显示 mysql.slow_log 的具体语句、用户/IP、耗时与扫描行，无法读取时回退到 performance_schema 语句摘要。"
        />

        <DashboardCard
          title="缓冲池命中率"
          icon="mdi-buffer"
          :value="mysql.bufferPoolHitRate.toFixed(2) + '%'"
          :subtitle="`使用 ${formatDbBytes(mysql.innodbBufferPoolUsed)} / ${formatDbBytes(mysql.innodbBufferPoolSize)}`"
          :progress="mysql.bufferPoolHitRate"
          :color="mysql.bufferPoolHitRate >= 99 ? 'green' : mysql.bufferPoolHitRate >= 95 ? 'cyan' : 'red'"
          :loading="loading"
          :chart-value="mysql.bufferPoolHitRate"
          :sample-key="sampleKey"
          description="根据 InnoDB 逻辑读请求与物理读计算，越接近 100% 越好。"
        />

        <DashboardCard
          title="数据大小"
          icon="mdi-database-arrow-down"
          :value="formatDbBytes(mysql.dataSize)"
          :subtitle="`索引 ${formatDbBytes(mysql.indexSize)}`"
          color="blue"
          :loading="loading"
          :progress="mysqlDataRatio"
          :chart-value="mysql.dataSize + mysql.indexSize"
          :sample-key="sampleKey"
          :details="[
            { label: '数据文件', value: formatDbBytes(mysql.dataSize) },
            { label: '索引文件', value: formatDbBytes(mysql.indexSize) },
          ]"
          :description="database ? `当前数据库 ${database} 的表数据与索引占用。` : '请先选择数据库后查看准确容量。'"
        />

        <DashboardCard
          title="表数量"
          icon="mdi-table"
          :value="mysql.tableCount"
          color="cyan"
          :loading="loading"
          :chart-value="mysql.tableCount"
          :sample-key="sampleKey"
          :description="database ? `当前数据库 ${database} 的基础表与视图数量。` : '请先选择数据库后查看准确表数量。'"
        />

        <DashboardCard
          title="活跃线程"
          icon="mdi-application-cog"
          :value="mysql.threadsRunning"
          :subtitle="`${mysql.threadsConnected} 已连接`"
          color="green"
          :loading="loading"
          :chart-value="mysql.threadsRunning"
          :sample-key="sampleKey"
          :detail-table="mysqlConnectionTable"
          description="Threads_running 当前值；明细展示每个会话的客户端 IP、运行时长、状态及 SQL。"
        />

        <DashboardCard
          title="网络接收"
          icon="mdi-download-network"
          :value="formatDbBytes(mysql.bytesReceived)"
          color="blue"
          :loading="loading"
          :chart-value="mysql.bytesReceived"
          :sample-key="sampleKey"
        />

        <DashboardCard
          title="网络发送"
          icon="mdi-upload-network"
          :value="formatDbBytes(mysql.bytesSent)"
          color="blue"
          :loading="loading"
          :chart-value="mysql.bytesSent"
          :sample-key="sampleKey"
        />
      </div>
    </template>

    <!-- PostgreSQL 真实指标 -->
    <template v-else-if="dbType === 'postgresql'">
      <div class="dashboard-grid">
        <DashboardCard
          title="运行时间"
          icon="mdi-clock-outline"
          :value="formatDbUptime(postgres.uptimeSeconds)"
          :subtitle="`${postgres.uptimeSeconds} 秒`"
          color="cyan"
          :loading="loading"
          :chart-value="postgres.uptimeSeconds"
          :sample-key="sampleKey"
        />
        <DashboardCard
          title="连接数"
          icon="mdi-connection"
          :value="postgres.connections"
          :subtitle="`${postgres.activeConnections} 活跃 / ${postgres.maxConnections} 最大`"
          :progress="postgresConnectionUsage"
          :color="postgresConnectionUsage > 80 ? 'red' : postgresConnectionUsage > 50 ? 'yellow' : 'green'"
          :loading="loading"
          :chart-value="postgres.connections"
          :sample-key="sampleKey"
          :detail-table="postgresConnectionTable"
          description="pg_stat_activity 会话明细，展示客户端 IP、账号、应用、等待事件与当前 SQL。"
        />
        <DashboardCard
          title="活跃会话"
          icon="mdi-application-cog"
          :value="postgres.activeConnections"
          color="green"
          :loading="loading"
          :chart-value="postgres.activeConnections"
          :sample-key="sampleKey"
          :detail-table="postgresConnectionTable"
        />
        <DashboardCard
          title="慢语句"
          icon="mdi-turtle"
          :value="postgresSlowStatements.length"
          :color="postgresSlowStatements.length ? 'yellow' : 'green'"
          :loading="loading"
          :chart-value="postgresSlowStatements.length"
          :sample-key="sampleKey"
          :detail-table="postgresSlowQueryTable"
          description="优先读取 pg_stat_statements 的具体 SQL 和累计耗时；扩展不可用时展示当前运行超过 1 秒的语句及客户端 IP。"
        />
        <DashboardCard
          title="缓存命中率"
          icon="mdi-buffer"
          :value="postgres.cacheHitRate.toFixed(2) + '%'"
          :progress="postgres.cacheHitRate"
          :color="postgres.cacheHitRate >= 99 ? 'green' : postgres.cacheHitRate >= 95 ? 'cyan' : 'red'"
          :loading="loading"
          :chart-value="postgres.cacheHitRate"
          :sample-key="sampleKey"
        />
        <DashboardCard
          title="数据库大小"
          icon="mdi-database-arrow-down"
          :value="formatDbBytes(postgres.databaseSize)"
          color="blue"
          :loading="loading"
          :chart-value="postgres.databaseSize"
          :sample-key="sampleKey"
        />
        <DashboardCard
          title="当前 Schema 表数"
          icon="mdi-table"
          :value="postgres.tableCount"
          color="cyan"
          :loading="loading"
          :chart-value="postgres.tableCount"
          :sample-key="sampleKey"
        />
        <DashboardCard
          title="累计事务"
          icon="mdi-swap-horizontal"
          :value="postgres.transactions.toLocaleString()"
          color="purple"
          :loading="loading"
          :chart-value="postgres.transactions"
          :sample-key="sampleKey"
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
