# ClickHouse 适配器设计

> 日期: 2026-06-12
> 状态: 已批准
> 范围: 新增 ClickHouse 数据库连接支持，功能完全对齐 MySQL

---

## 1. 目标

在 StarHub 中新增 ClickHouse 数据库连接，功能与 MySQL 完全一致（21 个方法），并额外支持 ClickHouse 特有元数据（分区信息、MergeTree 引擎信息、表统计）。

## 2. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| Go 驱动 | `github.com/ClickHouse/clickhouse-go/v2` | 官方维护，AGENTS.md 已指定 |
| SQL 工具 | `github.com/jmoiron/sqlx` | 与 MySQL 一致，struct 映射 |
| 前端视图 | 复用 `DbView.vue` | 通过 `dbType` 判断 SQL 方言 |

## 3. 架构

```
Vue Frontend (src/services/db.ts)
    |  invoke('db_clickhouse_connect', ...)
    v
Tauri Rust Commands (src-tauri/src/commands/db.rs)
    |  sidecar.call("db.clickhouse.connect", params)
    v
Go Sidecar (sidecar/adapters/clickhouse.go)
    |  clickhouse-go/v2 + sqlx
    v
ClickHouse Server
```

## 4. 后端实现

### 4.1 新文件: `sidecar/adapters/clickhouse.go`

```go
type ClickHouseAdapter struct {
    db   *sqlx.DB
    conn *ClickHouseConnInfo
}

type ClickHouseConnInfo struct {
    Host     string `json:"host"`
    Port     int    `json:"port"`      // 默认 9000
    Username string `json:"username"`
    Password string `json:"password"`
    Database string `json:"database,omitempty"`
    SSL      bool   `json:"ssl,omitempty"`
}
```

**连接池配置**: MaxOpenConns=10, MaxIdleConns=5, ConnMaxLifetime=30min
**超时**: connect 10s, read 30s, write 30s

### 4.2 方法清单（与 MySQL 对齐）

| # | 方法 | ClickHouse SQL | 备注 |
|---|------|----------------|------|
| 1 | `NewClickHouseAdapter` | — | 构造函数 |
| 2 | `Close` | — | 关闭连接 |
| 3 | `Ping` | — | 检测连接 |
| 4 | `ListDatabases` | `SELECT name FROM system.databases` | |
| 5 | `ListTables` | `SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = ?` | 含 engine 信息 |
| 6 | `ListColumns` | `SELECT name, type, default_kind, comment FROM system.columns WHERE database = ? AND table = ?` | |
| 7 | `ListIndexes` | — | ClickHouse 无传统索引概念，返回空 |
| 8 | `CreateIndex` | — | 不支持，返回提示 |
| 9 | `DropIndex` | — | 不支持，返回提示 |
| 10 | `Execute` | 智能路由 SELECT/其他 | 自动追加 LIMIT 100 |
| 11 | `Explain` | `EXPLAIN ...` | |
| 12 | `GetTableDDL` | `SHOW CREATE TABLE` | |
| 13 | `GetTableData` | `SELECT ... FROM ... LIMIT ? OFFSET ?` | ClickHouse 21.8+ 支持 OFFSET |
| 14 | `GetRowCount` | `SELECT count() FROM <table>` | |
| 15 | `GetTableMeta` | 并行获取 columns + rowCount | |
| 16 | `DropTable` | `DROP TABLE` | |
| 17 | `TruncateTable` | `TRUNCATE TABLE` | |
| 18 | `RenameTable` | `RENAME TABLE` | |
| 19 | `InsertRow` | `INSERT INTO ... VALUES (...)` | |
| 20 | `UpdateRows` | `ALTER TABLE ... UPDATE ... WHERE ...` | ClickHouse 异步 mutation |
| 21 | `DeleteRows` | `ALTER TABLE ... DELETE WHERE ...` | ClickHouse 异步 mutation |
| 22 | `ExportCSV` | 流式导出 | |
| 23 | `ExportJSON` | 流式导出 | |

### 4.3 ClickHouse 特有方法

| 方法 | SQL | 用途 |
|------|-----|------|
| `GetPartitions` | `SELECT partition, name, rows, size_in_bytes FROM system.parts WHERE database = ? AND table = ?` | 分区信息 |
| `GetMergeTreeInfo` | `SELECT engine, sorting_key, partition_key, primary_key FROM system.tables WHERE database = ? AND table = ?` | MergeTree 引擎信息 |
| `GetTableStats` | `SELECT count() FROM <table>` + system.tables 元数据 | 表统计 |

### 4.4 SQL 方言差异处理

| 场景 | MySQL | ClickHouse |
|------|-------|------------|
| 分页 | `LIMIT ? OFFSET ?` | `LIMIT ? OFFSET ?`（21.8+） |
| 更新 | `UPDATE ... SET ... WHERE ...` | `ALTER TABLE ... UPDATE ... WHERE ...`（异步） |
| 删除 | `DELETE FROM ... WHERE ...` | `ALTER TABLE ... DELETE WHERE ...`（异步） |
| 索引 | `SHOW INDEX FROM` | 无传统索引，跳过 |
| DDL | `SHOW CREATE TABLE` | `SHOW CREATE TABLE`（一致） |
| 引擎 | 无 | `engine` 字段（MergeTree, ReplacingMergeTree 等） |

## 5. RPC 注册

在 `sidecar/adapters/handlers.go` 的 `RegisterDBHandlers` 中新增：

```go
// ClickHouse
server.Register("db.clickhouse.connect", handleClickHouseConnect(mgr))
server.Register("db.clickhouse.test", handleClickHouseTest())
server.Register("db.clickhouse.disconnect", handleDisconnect(mgr))
server.Register("db.clickhouse.listDatabases", handleClickHouseListDatabases(mgr))
server.Register("db.clickhouse.listTables", handleClickHouseListTables(mgr))
server.Register("db.clickhouse.listColumns", handleClickHouseListColumns(mgr))
server.Register("db.clickhouse.listIndexes", handleClickHouseListIndexes(mgr))
server.Register("db.clickhouse.execute", handleClickHouseExecute(mgr))
server.Register("db.clickhouse.explain", handleClickHouseExplain(mgr))
server.Register("db.clickhouse.getTableDDL", handleClickHouseGetTableDDL(mgr))
server.Register("db.clickhouse.getTableData", handleClickHouseGetTableData(mgr))
server.Register("db.clickhouse.dropTable", handleClickHouseDropTable(mgr))
server.Register("db.clickhouse.truncateTable", handleClickHouseTruncateTable(mgr))
server.Register("db.clickhouse.renameTable", handleClickHouseRenameTable(mgr))
server.Register("db.clickhouse.insertRow", handleClickHouseInsertRow(mgr))
server.Register("db.clickhouse.updateRows", handleClickHouseUpdateRows(mgr))
server.Register("db.clickhouse.deleteRows", handleClickHouseDeleteRows(mgr))
server.Register("db.clickhouse.exportData", handleClickHouseExportData(mgr))
server.Register("db.clickhouse.getRowCount", handleClickHouseGetRowCount(mgr))
server.Register("db.clickhouse.getTableMeta", handleClickHouseGetTableMeta(mgr))
server.Register("db.clickhouse.createIndex", handleClickHouseCreateIndex(mgr))
server.Register("db.clickhouse.dropIndex", handleClickHouseDropIndex(mgr))
// ClickHouse 特有
server.Register("db.clickhouse.getPartitions", handleClickHouseGetPartitions(mgr))
server.Register("db.clickhouse.getMergeTreeInfo", handleClickHouseGetMergeTreeInfo(mgr))
server.Register("db.clickhouse.getTableStats", handleClickHouseGetTableStats(mgr))
```

## 6. 连接池扩展

`sidecar/pool/manager.go` 的 `ConnType` 新增：

```go
const (
    ConnTypeMySQL         ConnType = "mysql"
    ConnTypeRedis         ConnType = "redis"
    ConnTypeDocker        ConnType = "docker"
    ConnTypeElasticsearch ConnType = "elasticsearch"
    ConnTypeClickHouse    ConnType = "clickhouse"  // 新增
)
```

## 7. Rust 桥接

`src-tauri/src/commands/db.rs` 新增 `db_clickhouse_*` 系列 commands，转发到 sidecar：

```rust
#[tauri::command]
pub async fn db_clickhouse_connect(...) -> Result<ConnectionResult, String> { ... }
#[tauri::command]
pub async fn db_clickhouse_test(...) -> Result<bool, String> { ... }
// ... 共 21+ 个 commands
```

## 8. 前端

### 8.1 类型扩展

`src/types/asset.ts`:
```typescript
export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis' | 'elasticsearch' | 'clickhouse'
```

`src/types/db.ts` 新增:
```typescript
export interface ClickHouseConnectParams {
  host: string
  port: number
  username: string
  password: string
  database?: string
  ssl?: boolean
}
```

### 8.2 服务层

`src/services/db.ts` 新增 `connectClickHouse`, `testClickHouse`, `disconnectClickHouse` 等函数。

### 8.3 路由

`src/router/index.ts` 新增 `db/clickhouse/:id` 路由，复用 `DbView.vue`。

### 8.4 连接表单

`DbConnectionForm.vue` 的 `dbType` 选项新增 `clickhouse`，默认端口改为 `9000`。

### 8.5 图标与颜色

| 项 | 值 |
|---|---|
| 图标 | `mdi-database` (复用) |
| 连接卡片色块 | 新增 `.clickhouse` 类，颜色 `#FADB14` (ClickHouse 黄) |

## 9. go.mod 依赖新增

```
github.com/ClickHouse/clickhouse-go/v2
```

## 10. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `sidecar/adapters/clickhouse.go` | 新增 | ClickHouse 适配器（~600 行） |
| `sidecar/adapters/handlers.go` | 修改 | 注册 db.clickhouse.* handlers |
| `sidecar/pool/manager.go` | 修改 | ConnType 新增 clickhouse |
| `sidecar/go.mod` | 修改 | 新增 clickhouse-go/v2 依赖 |
| `src-tauri/src/commands/db.rs` | 修改 | 新增 db_clickhouse_* commands |
| `src/types/asset.ts` | 修改 | DatabaseType 新增 clickhouse |
| `src/types/db.ts` | 修改 | 新增 ClickHouseConnectParams |
| `src/services/db.ts` | 修改 | 新增 clickhouse 服务函数 |
| `src/router/index.ts` | 修改 | 新增路由 |
| `src/components/db/DbConnectionForm.vue` | 修改 | 新增 clickhouse 选项 + 默认端口 |
| `src/styles/cyber.css` | 修改 | 新增 .connection-icon.clickhouse 色块 |
