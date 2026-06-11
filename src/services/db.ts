import { invoke } from '@tauri-apps/api/core'
import type {
  MySQLConnectParams,
  RedisConnectParams,
  DbConnectionInfo,
  TestResult,
  QueryResult,
  TableInfo,
  ColumnMeta,
  IndexInfo,
  DDLResult,
  RowCountResult,
  TableMetaResult,
  InsertResult,
  RowsAffectedResult,
  ExportResult,
  RedisScanResult,
  RedisValueResult,
  RedisCommandResult,
  DeleteResult,
  SlowlogEntry,
  BigKeyEntry,
  MemoryAnalysisEntry,
  EsConnectParams,
  EsConnectResult,
  ClusterHealthInfo,
  EsIndexInfo,
  IndexMappingInfo,
  EsSearchResult,
  EsDocument,
  BulkResult,
  ScrollResult
} from '@/types/db'

// ─── MySQL ───

export async function mysqlConnect(params: MySQLConnectParams): Promise<DbConnectionInfo> {
  return invoke('db_mysql_connect', { params })
}

export async function mysqlTest(params: MySQLConnectParams): Promise<TestResult> {
  return invoke('db_mysql_test', { params })
}

export async function mysqlDisconnect(connId: string): Promise<void> {
  return invoke('db_mysql_disconnect', { connId })
}

export async function mysqlListDatabases(connId: string): Promise<string[]> {
  return invoke('db_mysql_list_databases', { connId })
}

export async function mysqlListTables(connId: string, database?: string): Promise<TableInfo[]> {
  return invoke('db_mysql_list_tables', { connId, database })
}

export async function mysqlListColumns(connId: string, table: string, database?: string): Promise<ColumnMeta[]> {
  return invoke('db_mysql_list_columns', { connId, table, database })
}

export async function mysqlListIndexes(connId: string, table: string, database?: string): Promise<IndexInfo[]> {
  return invoke('db_mysql_list_indexes', { connId, table, database })
}

export async function mysqlCreateIndex(
  connId: string,
  table: string,
  indexName: string,
  columns: string[],
  unique: boolean,
  indexType: string,
  database?: string
): Promise<void> {
  return invoke('db_mysql_create_index', { connId, table, indexName, columns, unique, indexType, database })
}

export async function mysqlDropIndex(
  connId: string,
  table: string,
  indexName: string,
  database?: string
): Promise<void> {
  return invoke('db_mysql_drop_index', { connId, table, indexName, database })
}

export async function mysqlExecute(connId: string, sql: string, database?: string): Promise<QueryResult> {
  return invoke('db_mysql_execute', { connId, sql, database })
}

export async function mysqlExplain(connId: string, sql: string, database?: string): Promise<QueryResult> {
  return invoke('db_mysql_explain', { connId, sql, database })
}

export async function mysqlGetTableDDL(connId: string, table: string, database?: string): Promise<DDLResult> {
  return invoke('db_mysql_get_table_ddl', { connId, table, database })
}

export async function mysqlGetTableData(
  connId: string,
  table: string,
  limit?: number,
  offset?: number,
  orderBy?: string,
  orderDir?: string,
  database?: string,
  filter?: string,
  columnFilters?: Record<string, string>
): Promise<QueryResult> {
  return invoke('db_mysql_get_table_data', { connId, table, limit, offset, orderBy, orderDir, database, filter, columnFilters })
}

export async function mysqlDropTable(connId: string, table: string, ifExists?: boolean, database?: string): Promise<void> {
  return invoke('db_mysql_drop_table', { connId, table, ifExists, database })
}

export async function mysqlTruncateTable(connId: string, table: string, database?: string): Promise<void> {
  return invoke('db_mysql_truncate_table', { connId, table, database })
}

export async function mysqlRenameTable(connId: string, oldName: string, newName: string, database?: string): Promise<void> {
  return invoke('db_mysql_rename_table', { connId, oldName, newName, database })
}

export async function mysqlInsertRow(connId: string, table: string, values: Record<string, unknown>, database?: string): Promise<InsertResult> {
  return invoke('db_mysql_insert_row', { connId, table, values, database })
}

export async function mysqlUpdateRows(connId: string, table: string, sets: Record<string, unknown>, where: string, database?: string): Promise<RowsAffectedResult> {
  return invoke('db_mysql_update_rows', { connId, table, sets, whereClause: where, database })
}

export async function mysqlDeleteRows(connId: string, table: string, where: string, database?: string): Promise<RowsAffectedResult> {
  return invoke('db_mysql_delete_rows', { connId, table, whereClause: where, database })
}

export async function mysqlExportData(connId: string, table: string, format: string, limit?: number, database?: string): Promise<ExportResult> {
  return invoke('db_mysql_export_data', { connId, table, format, limit, database })
}

export async function mysqlGetRowCount(connId: string, table: string, database?: string): Promise<RowCountResult> {
  return invoke('db_mysql_get_row_count', { connId, table, database })
}

export async function mysqlGetTableMeta(connId: string, table: string, database?: string): Promise<TableMetaResult> {
  return invoke('db_mysql_get_table_meta', { connId, table, database })
}

// ─── Redis ───

export async function redisConnect(params: RedisConnectParams): Promise<DbConnectionInfo> {
  return invoke('db_redis_connect', { params })
}

export async function redisTest(params: RedisConnectParams): Promise<TestResult> {
  return invoke('db_redis_test', { params })
}

export async function redisDisconnect(connId: string): Promise<void> {
  return invoke('db_redis_disconnect', { connId })
}

export async function redisSelect(connId: string, db: number): Promise<void> {
  return invoke('db_redis_select', { connId, db })
}

export async function redisScan(connId: string, cursor?: number, match?: string, count?: number): Promise<RedisScanResult> {
  return invoke('db_redis_scan', { connId, cursor: cursor || 0, match, count })
}

export async function redisGetValue(connId: string, key: string): Promise<RedisValueResult> {
  return invoke('db_redis_get_value', { connId, key })
}

export async function redisDel(connId: string, keys: string[]): Promise<DeleteResult> {
  return invoke('db_redis_del', { connId, keys })
}

export async function redisRename(connId: string, oldKey: string, newKey: string): Promise<void> {
  return invoke('db_redis_rename', { connId, oldKey, newKey })
}

export async function redisSet(connId: string, key: string, value: string, expiration?: number): Promise<void> {
  return invoke('db_redis_set', { connId, key, value, expiration })
}

export async function redisExecute(connId: string, command: string): Promise<RedisCommandResult> {
  return invoke('db_redis_execute', { connId, command })
}

export async function redisInfo(connId: string, section?: string): Promise<string> {
  return invoke('db_redis_info', { connId, section })
}

export async function redisDBSize(connId: string): Promise<{ size: number }> {
  return invoke('db_redis_db_size', { connId })
}

// ─── Redis Extended ───

export async function redisSlowlogGet(connId: string, count: number): Promise<SlowlogEntry[]> {
  return invoke('db_redis_slowlog_get', { connId, count })
}

export async function redisSlowlogReset(connId: string): Promise<void> {
  return invoke('db_redis_slowlog_reset', { connId })
}

export async function redisScanAll(connId: string, match?: string, count?: number): Promise<RedisScanResult> {
  return invoke('db_redis_scan_all', { connId, match, count })
}

export async function redisBigKeyScan(connId: string, match?: string, stringThreshold?: number, memberThreshold?: number): Promise<BigKeyEntry[]> {
  return invoke('db_redis_bigkey_scan', { connId, match, stringThreshold, memberThreshold })
}

export async function redisMemoryAnalysis(connId: string, match?: string, sampleSize?: number): Promise<MemoryAnalysisEntry[]> {
  return invoke('db_redis_memory_analysis', { connId, match, sampleSize })
}

export async function redisFlushDB(connId: string): Promise<void> {
  return invoke('db_redis_flush_db', { connId })
}

export async function redisSubscribe(connId: string, channels: string[], patterns: string[]): Promise<void> {
  return invoke('db_redis_subscribe', { connId, channels, patterns })
}

export async function redisUnsubscribe(connId: string, channels: string[]): Promise<void> {
  return invoke('db_redis_unsubscribe', { connId, channels })
}

// ─── Elasticsearch ───

export async function esConnect(params: EsConnectParams): Promise<EsConnectResult> {
  return invoke('db_es_connect', { params })
}

export async function esTest(params: EsConnectParams): Promise<TestResult> {
  return invoke('db_es_test', { params })
}

export async function esDisconnect(connId: string): Promise<void> {
  return invoke('db_es_disconnect', { connId })
}

export async function esClusterHealth(connId: string): Promise<ClusterHealthInfo> {
  return invoke('db_es_cluster_health', { connId })
}

export async function esClusterStats(connId: string): Promise<Record<string, unknown>> {
  return invoke('db_es_cluster_stats', { connId })
}

export async function esListIndices(connId: string): Promise<EsIndexInfo[]> {
  return invoke('db_es_list_indices', { connId })
}

export async function esGetMapping(connId: string, index: string): Promise<IndexMappingInfo> {
  return invoke('db_es_get_index_mapping', { connId, index })
}

export async function esGetSettings(connId: string, index: string): Promise<Record<string, unknown>> {
  return invoke('db_es_get_index_settings', { connId, index })
}

export async function esCreateIndex(
  connId: string, index: string,
  mappings?: Record<string, unknown>,
  settings?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return invoke('db_es_create_index', { connId, index, mappings, settings })
}

export async function esDeleteIndex(connId: string, index: string): Promise<Record<string, unknown>> {
  return invoke('db_es_delete_index', { connId, index })
}

export async function esSearch(
  connId: string, index: string, body: Record<string, unknown>,
  from?: number, size?: number
): Promise<EsSearchResult> {
  return invoke('db_es_search', { connId, index, body, from, size })
}

export async function esCount(
  connId: string, index: string, body?: Record<string, unknown>
): Promise<{ count: number }> {
  return invoke('db_es_count', { connId, index, body })
}

export async function esGetDocument(
  connId: string, index: string, id: string
): Promise<EsDocument> {
  return invoke('db_es_get_document', { connId, index, id })
}

export async function esIndexDocument(
  connId: string, index: string, body: Record<string, unknown>, id?: string
): Promise<Record<string, unknown>> {
  return invoke('db_es_index_document', { connId, index, body, id })
}

export async function esUpdateDocument(
  connId: string, index: string, id: string, body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return invoke('db_es_update_document', { connId, index, id, body })
}

export async function esDeleteDocument(
  connId: string, index: string, id: string
): Promise<Record<string, unknown>> {
  return invoke('db_es_delete_document', { connId, index, id })
}

export async function esBulkIndex(
  connId: string, index: string, documents: Record<string, unknown>[]
): Promise<BulkResult> {
  return invoke('db_es_bulk_index', { connId, index, documents })
}

export async function esExportJSON(
  connId: string, index: string, body?: Record<string, unknown>, size?: number
): Promise<{ documents: Record<string, unknown>[]; count: number }> {
  return invoke('db_es_export_json', { connId, index, body, size })
}

export async function esScrollSearch(
  connId: string, index: string, body: Record<string, unknown>, size?: number
): Promise<ScrollResult> {
  return invoke('db_es_scroll_search', { connId, index, body, size })
}
