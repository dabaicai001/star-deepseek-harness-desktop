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
  InsertResult,
  RowsAffectedResult,
  ExportResult,
  RedisScanResult,
  RedisValueResult,
  RedisCommandResult,
  DeleteResult
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

export async function mysqlListIndexes(connId: string, table: string): Promise<IndexInfo[]> {
  return invoke('db_mysql_list_indexes', { connId, table })
}

export async function mysqlExecute(connId: string, sql: string): Promise<QueryResult> {
  return invoke('db_mysql_execute', { connId, sql })
}

export async function mysqlExplain(connId: string, sql: string): Promise<QueryResult> {
  return invoke('db_mysql_explain', { connId, sql })
}

export async function mysqlGetTableDDL(connId: string, table: string): Promise<DDLResult> {
  return invoke('db_mysql_get_table_ddl', { connId, table })
}

export async function mysqlGetTableData(
  connId: string,
  table: string,
  limit?: number,
  offset?: number,
  orderBy?: string,
  orderDir?: string
): Promise<QueryResult> {
  return invoke('db_mysql_get_table_data', { connId, table, limit, offset, orderBy, orderDir })
}

export async function mysqlDropTable(connId: string, table: string, ifExists?: boolean): Promise<void> {
  return invoke('db_mysql_drop_table', { connId, table, ifExists })
}

export async function mysqlTruncateTable(connId: string, table: string): Promise<void> {
  return invoke('db_mysql_truncate_table', { connId, table })
}

export async function mysqlRenameTable(connId: string, oldName: string, newName: string): Promise<void> {
  return invoke('db_mysql_rename_table', { connId, oldName, newName })
}

export async function mysqlInsertRow(connId: string, table: string, values: Record<string, unknown>): Promise<InsertResult> {
  return invoke('db_mysql_insert_row', { connId, table, values })
}

export async function mysqlUpdateRows(connId: string, table: string, sets: Record<string, unknown>, where: string): Promise<RowsAffectedResult> {
  return invoke('db_mysql_update_rows', { connId, table, sets, where })
}

export async function mysqlDeleteRows(connId: string, table: string, where: string): Promise<RowsAffectedResult> {
  return invoke('db_mysql_delete_rows', { connId, table, where })
}

export async function mysqlExportData(connId: string, table: string, format: string, limit?: number): Promise<ExportResult> {
  return invoke('db_mysql_export_data', { connId, table, format, limit })
}

export async function mysqlGetRowCount(connId: string, table: string): Promise<RowCountResult> {
  return invoke('db_mysql_get_row_count', { connId, table })
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
