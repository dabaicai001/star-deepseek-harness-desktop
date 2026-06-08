/**
 * 解析数据库服务器真实状态数据 → 仪表盘结构。
 * 全部来自后端 RPC 真实返回,无 mock。
 *
 * - Redis: `redisInfo` 返回的 `info all` 文本
 * - MySQL: 跑 `SHOW GLOBAL STATUS` + `SHOW GLOBAL VARIABLES` 拿到的 `QueryResult`
 */
import type { QueryResult } from '@/types/db'

/** Redis INFO 解析后的关键指标 */
export interface RedisMetrics {
  version: string
  uptimeSeconds: number
  uptimePretty: string
  connectedClients: number
  connectedSlaves: number
  usedMemory: number
  usedMemoryPeak: number
  usedMemoryHuman: string
  totalKeys: number /** 由 dbsize 求和,单数则用 dbSize 字段 */
  hitRate: number /** keyspace_hits / (keyspace_hits + keyspace_misses) */
  totalCommandsProcessed: number
  instantaneousOpsPerSec: number
  role: string
  maxmemory: number
  raw: string
}

/** MySQL SHOW STATUS / SHOW VARIABLES 解析后的关键指标 */
export interface MysqlMetrics {
  version: string
  uptimeSeconds: number
  uptimePretty: string
  threadsConnected: number
  threadsRunning: number
  maxConnections: number
  questions: number
  slowQueries: number
  queries: number
  bytesReceived: number
  bytesSent: number
  innodbBufferPoolSize: number
  innodbBufferPoolUsed: number
  /** 0-100,来自 innodb_buffer_pool_hit_rate(自算) */
  bufferPoolHitRate: number
  tableCount: number
  dataSize: number
  indexSize: number
}

/** 字节 → 可读 */
export function formatDbBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/** 秒 → "X天 Y小时 Z分钟" */
export function formatDbUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '--'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${mins}分钟`
  return `${mins}分钟`
}

/**
 * 解析 Redis INFO 文本(支持 `info all` / `info default` / `info memory` 等任意 section)
 * section 头是 `# Server` / `# Memory` 这种注释行
 */
export function parseRedisInfo(text: string, dbSize?: number): RedisMetrics {
  const get = (key: string): string => {
    const re = new RegExp(`^${key}:(.*)$`, 'm')
    const m = text.match(re)
    return m ? m[1].trim() : ''
  }
  const uptimeSeconds = parseInt(get('uptime_in_seconds'), 10) || 0
  const usedMemory = parseInt(get('used_memory'), 10) || 0
  const hits = parseInt(get('keyspace_hits'), 10) || 0
  const misses = parseInt(get('keyspace_misses'), 10) || 0
  return {
    version: get('redis_version') || '--',
    uptimeSeconds,
    uptimePretty: formatDbUptime(uptimeSeconds),
    connectedClients: parseInt(get('connected_clients'), 10) || 0,
    connectedSlaves: parseInt(get('connected_slaves') || get('connected_slaves'), 10) || 0,
    usedMemory,
    usedMemoryPeak: parseInt(get('used_memory_peak'), 10) || 0,
    usedMemoryHuman: get('used_memory_human') || '0B',
    totalKeys: dbSize ?? 0,
    hitRate: hits + misses > 0 ? (hits / (hits + misses)) * 100 : 0,
    totalCommandsProcessed: parseInt(get('total_commands_processed'), 10) || 0,
    instantaneousOpsPerSec: parseInt(get('instantaneous_ops_per_sec'), 10) || 0,
    role: get('role') || '--',
    maxmemory: parseInt(get('maxmemory'), 10) || 0,
    raw: text,
  }
}

/**
 * 把 SHOW GLOBAL STATUS / SHOW VARIABLES / SELECT 结果(两列 name, value)
 * 转成 dict,方便按 key 查值。
 */
export function rowsToDict(result: QueryResult): Record<string, string> {
  if (!result?.rows?.length) return {}
  // 找到 name/value 列下标(不依赖具体列名顺序,兼容 SHOW / SELECT)
  const colNames = (result.columns || []).map(c => c.name.toLowerCase())
  let nameIdx = colNames.findIndex(n => /name|variable/i.test(n))
  let valueIdx = colNames.findIndex(n => /value/i.test(n))
  if (nameIdx < 0) nameIdx = 0
  if (valueIdx < 0) valueIdx = 1
  const dict: Record<string, string> = {}
  for (const row of result.rows) {
    const k = String(row[nameIdx] ?? '')
    const v = String(row[valueIdx] ?? '')
    if (k) dict[k] = v
  }
  return dict
}

/** 从 dict 取数字,缺失返回 fallback */
export function num(dict: Record<string, string>, key: string, fallback = 0): number {
  const v = dict[key]
  if (v === undefined || v === '') return fallback
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 解析 MySQL 状态:
 * - status: SHOW GLOBAL STATUS 的结果
 * - variables: SHOW GLOBAL VARIABLES 的结果
 * - tableStats: `SELECT table_schema, COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() GROUP BY table_schema` 的结果(可选)
 * - sizeStats: `SELECT SUM(data_length), SUM(index_length) FROM information_schema.tables WHERE table_schema = DATABASE()` 的结果(可选)
 * - innodbStats: `SHOW ENGINE INNODB STATUS`(可选,用于取 buffer pool hit rate)
 */
export function parseMysqlMetrics(opts: {
  status: QueryResult
  variables: QueryResult
  tableStats?: QueryResult
  sizeStats?: QueryResult
  innodbStats?: QueryResult
}): MysqlMetrics {
  const status = rowsToDict(opts.status)
  const variables = rowsToDict(opts.variables)
  const threadsConnected = num(status, 'Threads_connected')
  const threadsRunning = num(status, 'Threads_running')
  const maxConnections = num(variables, 'max_connections', 151)
  const uptime = num(status, 'Uptime')
  const questions = num(status, 'Questions')
  const slowQueries = num(status, 'Slow_queries')
  const queries = num(status, 'Queries')
  const bytesReceived = num(status, 'Bytes_received')
  const bytesSent = num(status, 'Bytes_sent')
  const innodbBP = num(status, 'Innodb_buffer_pool_pages_total')
  const innodbBPFree = num(status, 'Innodb_buffer_pool_pages_free')
  const innodbBPDirty = num(status, 'Innodb_buffer_pool_pages_dirty') || 0
  const innodbBPData = num(status, 'Innodb_buffer_pool_pages_data') || 0
  const innodbBPSize = num(variables, 'innodb_buffer_pool_size')
  const innodbReadReq = num(status, 'Innodb_buffer_pool_read_requests')
  const innodbReads = num(status, 'Innodb_buffer_pool_reads')
  const hitRate = innodbReadReq + innodbReads > 0
    ? (innodbReadReq / (innodbReadReq + innodbReads)) * 100
    : 0
  // 实际已用: pages_total - pages_free - pages_misc(用 dirty 近似) 这种不严谨,直接用 total - free
  const bufferPoolUsed = Math.max(0, (innodbBP - innodbBPFree) * 16 * 1024)
  let tableCount = 0
  let dataSize = 0
  let indexSize = 0
  if (opts.tableStats?.rows?.length) {
    // 期望: COUNT(*)
    const last = opts.tableStats.rows[0]
    tableCount = parseInt(String(last[last.length - 1] ?? '0'), 10) || 0
  }
  if (opts.sizeStats?.rows?.length) {
    const r = opts.sizeStats.rows[0]
    // 期望两列: SUM(data_length), SUM(index_length)
    dataSize = parseInt(String(r[0] ?? '0'), 10) || 0
    indexSize = parseInt(String(r[1] ?? '0'), 10) || 0
  }
  return {
    version: variables['version'] || variables['version_comment'] || '--',
    uptimeSeconds: uptime,
    uptimePretty: formatDbUptime(uptime),
    threadsConnected,
    threadsRunning,
    maxConnections,
    questions,
    slowQueries,
    queries,
    bytesReceived,
    bytesSent,
    innodbBufferPoolSize: innodbBPSize,
    innodbBufferPoolUsed: bufferPoolUsed,
    bufferPoolHitRate: hitRate,
    tableCount,
    dataSize,
    indexSize,
  }
}
