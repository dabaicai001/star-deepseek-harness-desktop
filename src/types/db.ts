export type DatabaseType = 'mysql' | 'redis'

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
  indexType: string
  comment: string
}

export interface DDLResult {
  ddl: string
}

export interface RowCountResult {
  count: number
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
