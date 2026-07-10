export type DatabaseType = 'mysql' | 'postgresql' | 'redis' | 'elasticsearch' | 'clickhouse' | 'kafka' | 'nsq'

export interface DbConnectionInfo {
  connId: string
  host: string
  port: number
  database?: string
  db?: number
}

export interface MySQLConnectParams {
  host: string
  port: number
  username: string
  password: string
  database?: string
  ssl?: boolean
}

export interface RedisConnectParams {
  host: string
  port: number
  password?: string
  db: number
  ssl?: boolean
}

export interface ClickHouseConnectParams {
  host: string
  port: number
  username: string
  password: string
  database?: string
  ssl?: boolean
}

export interface TestResult {
  ok: boolean
  message: string
  elapsed_ms?: number
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
}

export interface QueryResult {
  columns: ColumnInfo[]
  rows: unknown[][]
  rowsAffected: number
  lastInsertId?: number
  durationMs: number
  isSelect: boolean
  error?: string
  totalRows?: number
}

export interface TableInfo {
  name: string
  type: string
  engine?: string
  rows?: number
  comment?: string
}

export interface ColumnMeta {
  name: string
  type: string
  dataType: string
  nullable: string
  key: string
  defaultValue: string | null
  extra: string
  comment: string
  ordinalPosition: number
}

export interface IndexInfo {
  tableName: string
  nonUnique: number
  keyName: string
  seqInIndex: number
  columnName: string
  collation: string
  cardinality: number | null
  subPart: number | null
  packed: string | null
  null: string
  indexType: string
  comment: string
  indexComment: string
  visible: string
  expression: string | null
}

export interface DDLResult {
  ddl: string
}

export interface RowCountResult {
  count: number
}

export interface TableMetaResult {
  columns: ColumnMeta[]
  rowCount: number
}

export interface InsertResult {
  lastInsertId: number
}

export interface RowsAffectedResult {
  rowsAffected: number
}

export interface ExportResult {
  data?: string
  result?: QueryResult
  format: string
}

// Redis types
export interface RedisKeyInfo {
  key: string
  type: string
  ttl: number
  size?: number
}

export interface RedisScanResult {
  keys: RedisKeyInfo[]
  cursor: number
  total?: number
}

export interface RedisValueResult {
  key: string
  type: string
  value: unknown
  ttl: number
  size?: number
}

export interface RedisCommandResult {
  result: unknown
  durationMs: number
  error?: string
}

export interface DeleteResult {
  deleted: number
}

// Redis extended types
export interface SlowlogEntry {
  id: number
  duration: number
  timestamp: number
  command: string
}

export interface BigKeyEntry {
  key: string
  type: string
  size: number
  length: number
}

export interface MemoryAnalysisEntry {
  prefix: string
  keys: number
  memory: number
  percentage: number
}

export interface PubSubMessage {
  channel: string
  pattern?: string
  payload: string
  time: string
}

// DB session info (for frontend state)
export interface DbSession {
  connId: string
  dbType: DatabaseType
  host: string
  port: number
  database: string
  connected: boolean
  name: string
  assetId: string
}

// Elasticsearch types
export interface EsConnectParams {
  address?: string
  host: string
  port: number
  username?: string
  password?: string
  useSSL?: boolean
  apiKey?: string
}

export interface EsConnectResult {
  connId: string
  host: string
  port: number
  clusterName: string
  version: string
}

export interface ClusterHealthInfo {
  clusterName: string
  status: 'green' | 'yellow' | 'red'
  numberOfNodes: number
  numberOfDataNodes: number
  activePrimaryShards: number
  activeShards: number
  activeShardsPercent: number
}

export interface EsIndexInfo {
  name: string
  docsCount: number
  storeSize: string
  health: string
  status: string
  primaryShards: number
  replicaShards: number
}

export interface EsFieldInfo {
  name: string
  type: string
  children?: EsFieldInfo[]
}

export interface IndexMappingInfo {
  indexName: string
  fields: EsFieldInfo[]
}

export interface EsSearchResult {
  took: number
  timedOut: boolean
  totalHits: number
  maxScore: number | null
  hits: EsSearchHit[]
  aggregations: Record<string, unknown>
}

export interface EsSearchHit {
  index: string
  id: string
  score: number | null
  source: Record<string, unknown>
}

export interface EsDocument {
  index: string
  id: string
  version: number
  found: boolean
  source: Record<string, unknown>
}

export interface BulkResult {
  took: number
  errors: boolean
  items: Record<string, unknown>[]
}

export interface ScrollResult {
  scrollId: string
  totalHits: number
  hits: EsSearchHit[]
}
