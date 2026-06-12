# ClickHouse 适配器实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 ClickHouse 数据库连接支持，功能完全对齐 MySQL（21+ 个方法），并支持 ClickHouse 特有元数据。

**Architecture:** 独立适配器文件 `clickhouse.go`，复用 MySQL 的 handler 注册模式。前端复用 `DbView.vue`，通过 `dbType` 判断 SQL 方言。全链路：Vue → Tauri commands → Go sidecar JSON-RPC → clickhouse-go/v2。

**Tech Stack:** Go (clickhouse-go/v2, sqlx, zerolog), Rust (tauri, serde_json), TypeScript (Vue 3, Pinia, vue-i18n)

---

## 文件结构

| 文件 | 操作 | 说明 |
|------|------|------|
| `sidecar/adapters/clickhouse.go` | 新增 | ClickHouse 适配器（~650 行） |
| `sidecar/adapters/handlers.go` | 修改 | 注册 `db.clickhouse.*` handlers |
| `sidecar/pool/manager.go` | 修改 | `ConnType` 新增 `clickhouse` |
| `sidecar/go.mod` | 修改 | 新增 `clickhouse-go/v2` 依赖 |
| `src-tauri/src/commands/db.rs` | 修改 | 新增 `db_clickhouse_*` commands |
| `src-tauri/src/main.rs` | 修改 | 注册 ClickHouse commands |
| `src/types/db.ts` | 修改 | 新增 `ClickHouseConnectParams` |
| `src/types/asset.ts` | 修改 | `DatabaseType` 新增 `'clickhouse'` |
| `src/services/db.ts` | 修改 | 新增 ClickHouse 服务函数 |
| `src/stores/db.ts` | 修改 | 新增 `connectClickHouse` |
| `src/router/index.ts` | 修改 | 新增 `db/clickhouse/:id` 路由 |
| `src/components/db/DbConnectionForm.vue` | 修改 | 新增 ClickHouse 选项 |
| `src/views/DbView.vue` | 修改 | 新增 ClickHouse 连接分支 |
| `src/styles/cyber.css` | 修改 | 新增 `.connection-icon.clickhouse` |

---

### Task 1: Go Sidecar — ClickHouse 适配器核心

**Files:**
- Create: `sidecar/adapters/clickhouse.go`

- [ ] **Step 1: 创建 clickhouse.go — 结构体 + 连接函数**

```go
package adapters

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/rs/zerolog/log"

	_ "github.com/ClickHouse/clickhouse-go/v2"
)

// ClickHouseAdapter 封装 ClickHouse 连接
type ClickHouseAdapter struct {
	db   *sqlx.DB
	conn *ClickHouseConnInfo
}

// ClickHouseConnInfo ClickHouse 连接参数
type ClickHouseConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database,omitempty"`
	SSL      bool   `json:"ssl,omitempty"`
}

// NewClickHouseAdapter 创建 ClickHouse 适配器
func NewClickHouseAdapter(info *ClickHouseConnInfo) (*ClickHouseAdapter, error) {
	if info.Port == 0 {
		info.Port = 9000
	}

	dsn := fmt.Sprintf("clickhouse://%s:%s@%s:%d/%s",
		info.Username, info.Password, info.Host, info.Port, info.Database)
	if info.Database == "" {
		dsn = fmt.Sprintf("clickhouse://%s:%s@%s:%d",
			info.Username, info.Password, info.Host, info.Port)
	}

	db, err := sqlx.Connect("clickhouse", dsn)
	if err != nil {
		return nil, fmt.Errorf("clickhouse connect failed: %w", err)
	}

	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)

	log.Info().Str("host", info.Host).Int("port", info.Port).Str("db", info.Database).Msg("clickhouse connected")

	return &ClickHouseAdapter{db: db, conn: info}, nil
}

// Close 关闭连接
func (a *ClickHouseAdapter) Close() error {
	return a.db.Close()
}

// Ping 检测连接
func (a *ClickHouseAdapter) Ping() error {
	return a.db.Ping()
}
```

- [ ] **Step 2: 添加 ClickHouse 专用元数据类型 + ListDatabases / ListTables / ListColumns**

由于 `ColumnMeta` 的 `db` tag 是 MySQL 风格（`COLUMN_NAME`），与 ClickHouse `system.columns` 列名不匹配，需要定义 ClickHouse 专用类型：

```go
// CHColumnMeta ClickHouse 列元数据（映射 system.columns）
type CHColumnMeta struct {
	Name            string `json:"name" db:"name"`
	Type            string `json:"type" db:"type"`
	DefaultKind     string `json:"defaultKind" db:"default_kind"`
	DefaultExpr     string `json:"defaultExpr" db:"default_expression"`
	Comment         string `json:"comment" db:"comment"`
	Position        int    `json:"position" db:"position"`
}

// ToColumnMeta 转换为通用 ColumnMeta（供前端使用）
func (c CHColumnMeta) ToColumnMeta() ColumnMeta {
	nullable := "NO"
	if c.DefaultKind != "" {
		nullable = "YES"
	}
	return ColumnMeta{
		Name:         c.Name,
		Type:         c.Type,
		DataType:     c.Type,
		Nullable:     nullable,
		Key:          "",
		DefaultValue: &c.DefaultExpr,
		Extra:        c.DefaultKind,
		Comment:      c.Comment,
		OrdinalPos:   c.Position,
	}
}

// ListDatabases 列出所有数据库
func (a *ClickHouseAdapter) ListDatabases() ([]string, error) {
	var dbs []string
	err := a.db.Select(&dbs, "SELECT name FROM system.databases ORDER BY name")
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	return dbs, nil
}

// ListTables 列出当前数据库的所有表
func (a *ClickHouseAdapter) ListTables(database string) ([]TableInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	// 使用别名让列名匹配 TableInfo 的 JSON tag
	query := `SELECT name, engine as type, engine, total_rows as rows, comment
		FROM system.tables WHERE database = ? ORDER BY name`
	var tables []TableInfo
	err := a.db.Select(&tables, query, database)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	return tables, nil
}

// ListColumns 列出表的所有列
func (a *ClickHouseAdapter) ListColumns(database, table string) ([]ColumnMeta, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT name, type, default_kind, default_expression, comment, position
		FROM system.columns 
		WHERE database = ? AND table = ?
		ORDER BY position`
	var chCols []CHColumnMeta
	err := a.db.Select(&chCols, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("list columns: %w", err)
	}
	cols := make([]ColumnMeta, len(chCols))
	for i, c := range chCols {
		cols[i] = c.ToColumnMeta()
	}
	return cols, nil
}
```

- [ ] **Step 3: 添加 ListIndexes / CreateIndex / DropIndex（ClickHouse 不支持，返回空/提示）**

```go
// ListIndexes ClickHouse 无传统索引概念，返回空
func (a *ClickHouseAdapter) ListIndexes(database, table string) ([]IndexInfo, error) {
	return []IndexInfo{}, nil
}

// CreateIndex ClickHouse 不支持传统索引
func (a *ClickHouseAdapter) CreateIndex(database, table, indexName string, columns []string, unique bool, indexType string) error {
	return fmt.Errorf("ClickHouse does not support traditional indexes. Use ORDER BY clause in table engine instead")
}

// DropIndex ClickHouse 不支持传统索引
func (a *ClickHouseAdapter) DropIndex(database, table, indexName string) error {
	return fmt.Errorf("ClickHouse does not support traditional indexes")
}
```

- [ ] **Step 4: 添加 Execute / Explain / GetTableDDL**

```go
// Execute 执行 SQL
func (a *ClickHouseAdapter) Execute(sqlStr string) (*QueryResult, error) {
	start := time.Now()

	sqlStr = strings.TrimSpace(sqlStr)
	if sqlStr == "" {
		return &QueryResult{Error: "empty SQL"}, nil
	}

	upper := strings.ToUpper(sqlStr)
	isSelect := strings.HasPrefix(upper, "SELECT") ||
		strings.HasPrefix(upper, "SHOW") ||
		strings.HasPrefix(upper, "DESCRIBE") ||
		strings.HasPrefix(upper, "EXPLAIN")

	if isSelect {
		if !strings.Contains(upper, "LIMIT") {
			sqlStr = sqlStr + " LIMIT 100"
		}
		return a.executeSelect(sqlStr, start)
	}
	return a.executeExec(sqlStr, start)
}

func (a *ClickHouseAdapter) executeSelect(sqlStr string, start time.Time) (*QueryResult, error) {
	rows, err := a.db.Queryx(sqlStr)
	if err != nil {
		return &QueryResult{
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
			IsSelect:   true,
		}, nil
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return &QueryResult{Error: err.Error(), DurationMs: time.Since(start).Milliseconds()}, nil
	}

	colInfos := make([]ColumnInfo, len(columns))
	for i, name := range columns {
		colInfos[i] = ColumnInfo{Name: name}
	}

	var resultRows [][]interface{}
	for rows.Next() {
		values, err := rows.SliceScan()
		if err != nil {
			return &QueryResult{Error: err.Error(), DurationMs: time.Since(start).Milliseconds()}, nil
		}
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}
		resultRows = append(resultRows, values)
	}

	return &QueryResult{
		Columns:    colInfos,
		Rows:       resultRows,
		IsSelect:   true,
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

func (a *ClickHouseAdapter) executeExec(sqlStr string, start time.Time) (*QueryResult, error) {
	result, err := a.db.Exec(sqlStr)
	if err != nil {
		return &QueryResult{
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}, nil
	}

	affected, _ := result.RowsAffected()

	return &QueryResult{
		RowsAffected: affected,
		DurationMs:   time.Since(start).Milliseconds(),
	}, nil
}

// Explain 获取执行计划
func (a *ClickHouseAdapter) Explain(sqlStr string) (*QueryResult, error) {
	return a.executeSelect("EXPLAIN "+sqlStr, time.Now())
}

// GetTableDDL 获取建表 DDL
func (a *ClickHouseAdapter) GetTableDDL(database, table string) (string, error) {
	if database == "" {
		database = a.conn.Database
	}
	var ddl string
	err := a.db.QueryRow(fmt.Sprintf("SHOW CREATE TABLE `%s`.`%s`", database, table)).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("get ddl: %w", err)
	}
	return ddl, nil
}
```

- [ ] **Step 5: 添加 GetTableData / GetRowCount / GetTableMeta**

```go
// GetTableData 分页获取表数据
func (a *ClickHouseAdapter) GetTableData(database, table string, limit, offset int, orderBy, orderDir, filter string, columnFilters map[string]string) (*QueryResult, error) {
	if database == "" {
		database = a.conn.Database
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 10000 {
		limit = 10000
	}

	query := fmt.Sprintf("SELECT * FROM `%s`.`%s`", database, table)

	var conditions []string
	var args []interface{}

	if filter != "" {
		conditions = append(conditions, "("+filter+")")
	}

	if len(columnFilters) > 0 {
		for col, val := range columnFilters {
			conditions = append(conditions, fmt.Sprintf("`%s` = ?", col))
			args = append(args, val)
		}
	}

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = " WHERE " + strings.Join(conditions, " AND ")
		query += whereClause
	}

	if orderBy != "" {
		dir := "ASC"
		if strings.ToUpper(orderDir) == "DESC" {
			dir = "DESC"
		}
		query += fmt.Sprintf(" ORDER BY `%s` %s", orderBy, dir)
	}
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)

	var result *QueryResult
	var execErr error
	if len(args) > 0 {
		result, execErr = a.executeSelectArgs(query, args, time.Now())
	} else {
		result, execErr = a.executeSelect(query, time.Now())
	}
	if execErr != nil {
		return nil, fmt.Errorf("get table data: %w", execErr)
	}

	if whereClause != "" && result.Error == "" {
		countQuery := fmt.Sprintf("SELECT COUNT(*) FROM `%s`.`%s`%s", database, table, whereClause)
		var totalRows int64
		if len(args) > 0 {
			if err := a.db.Get(&totalRows, countQuery, args...); err == nil {
				result.TotalRows = totalRows
			}
		} else {
			if err := a.db.Get(&totalRows, countQuery); err == nil {
				result.TotalRows = totalRows
			}
		}
	}

	return result, nil
}

func (a *ClickHouseAdapter) executeSelectArgs(sqlStr string, args []interface{}, start time.Time) (*QueryResult, error) {
	rows, err := a.db.Queryx(sqlStr, args...)
	if err != nil {
		return &QueryResult{
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
			IsSelect:   true,
		}, nil
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return &QueryResult{Error: err.Error(), DurationMs: time.Since(start).Milliseconds()}, nil
	}

	colInfos := make([]ColumnInfo, len(columns))
	for i, name := range columns {
		colInfos[i] = ColumnInfo{Name: name}
	}

	var resultRows [][]interface{}
	for rows.Next() {
		values, err := rows.SliceScan()
		if err != nil {
			return &QueryResult{Error: err.Error(), DurationMs: time.Since(start).Milliseconds()}, nil
		}
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}
		resultRows = append(resultRows, values)
	}

	return &QueryResult{
		Columns:    colInfos,
		Rows:       resultRows,
		IsSelect:   true,
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

// GetRowCount 获取表行数
func (a *ClickHouseAdapter) GetRowCount(database, table string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	var count int64
	err := a.db.Get(&count, fmt.Sprintf("SELECT COUNT(*) FROM `%s`.`%s`", database, table))
	return count, err
}

// GetTableMeta 批量获取表元信息（列 + 行数，并行）
func (a *ClickHouseAdapter) GetTableMeta(database, table string) (*TableMeta, error) {
	if database == "" {
		database = a.conn.Database
	}
	var (
		columns  []ColumnMeta
		rowCount int64
		colsErr  error
		cntErr   error
		wg       sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		columns, colsErr = a.ListColumns(database, table)
	}()
	go func() {
		defer wg.Done()
		rowCount, cntErr = a.GetRowCount(database, table)
	}()
	wg.Wait()

	if colsErr != nil {
		return nil, fmt.Errorf("list columns: %w", colsErr)
	}
	if cntErr != nil {
		return nil, fmt.Errorf("get row count: %w", cntErr)
	}
	return &TableMeta{Columns: columns, RowCount: rowCount}, nil
}
```

- [ ] **Step 6: 添加 DropTable / TruncateTable / RenameTable / InsertRow / UpdateRows / DeleteRows**

```go
// DropTable 删除表
func (a *ClickHouseAdapter) DropTable(database, table string, ifExists bool) error {
	if database == "" {
		database = a.conn.Database
	}
	stmt := "DROP TABLE"
	if ifExists {
		stmt += " IF EXISTS"
	}
	stmt += fmt.Sprintf(" `%s`.`%s`", database, table)
	_, err := a.db.Exec(stmt)
	return err
}

// TruncateTable 清空表
func (a *ClickHouseAdapter) TruncateTable(database, table string) error {
	if database == "" {
		database = a.conn.Database
	}
	_, err := a.db.Exec(fmt.Sprintf("TRUNCATE TABLE `%s`.`%s`", database, table))
	return err
}

// RenameTable 重命名表
func (a *ClickHouseAdapter) RenameTable(database, oldName, newName string) error {
	if database == "" {
		database = a.conn.Database
	}
	_, err := a.db.Exec(fmt.Sprintf("RENAME TABLE `%s`.`%s` TO `%s`.`%s`", database, oldName, database, newName))
	return err
}

// InsertRow 插入一行
func (a *ClickHouseAdapter) InsertRow(database, table string, values map[string]interface{}) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	cols := make([]string, 0, len(values))
	placeholders := make([]string, 0, len(values))
	args := make([]interface{}, 0, len(values))
	for col, val := range values {
		cols = append(cols, fmt.Sprintf("`%s`", col))
		placeholders = append(placeholders, "?")
		args = append(args, val)
	}

	query := fmt.Sprintf("INSERT INTO `%s`.`%s` (%s) VALUES (%s)", database, table,
		strings.Join(cols, ", "), strings.Join(placeholders, ", "))
	_, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return 0, nil // ClickHouse 无 LastInsertId
}

// UpdateRows 更新行（ClickHouse 使用 ALTER TABLE UPDATE，异步 mutation）
func (a *ClickHouseAdapter) UpdateRows(database, table string, sets map[string]interface{}, where string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	setParts := make([]string, 0, len(sets))
	args := make([]interface{}, 0, len(sets))
	for col, val := range sets {
		setParts = append(setParts, fmt.Sprintf("`%s` = ?", col))
		args = append(args, val)
	}

	query := fmt.Sprintf("ALTER TABLE `%s`.`%s` UPDATE %s", database, table, strings.Join(setParts, ", "))
	if where != "" {
		query += " WHERE " + where
	}

	_, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return 0, nil // ClickHouse mutations are async
}

// DeleteRows 删除行（ClickHouse 使用 ALTER TABLE DELETE，异步 mutation）
func (a *ClickHouseAdapter) DeleteRows(database, table, where string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := fmt.Sprintf("ALTER TABLE `%s`.`%s` DELETE", database, table)
	if where != "" {
		query += " WHERE " + where
	}
	_, err := a.db.Exec(query)
	if err != nil {
		return 0, err
	}
	return 0, nil // ClickHouse mutations are async
}
```

- [ ] **Step 7: 添加 ExportCSV / ExportJSON + ClickHouse 特有方法**

```go
// ExportCSV 导出表为 CSV
func (a *ClickHouseAdapter) ExportCSV(database, table string, limit int) (*QueryResult, error) {
	if database == "" {
		database = a.conn.Database
	}
	if limit <= 0 {
		limit = 100000
	}
	query := fmt.Sprintf("SELECT * FROM `%s`.`%s` LIMIT %d", database, table, limit)
	return a.executeSelect(query, time.Now())
}

// ExportJSON 导出表为 JSON
func (a *ClickHouseAdapter) ExportJSON(database, table string, limit int) (string, error) {
	result, err := a.ExportCSV(database, table, limit)
	if err != nil {
		return "", err
	}

	type Row map[string]interface{}
	rows := make([]Row, len(result.Rows))
	for i, row := range result.Rows {
		r := make(Row, len(result.Columns))
		for j, col := range result.Columns {
			if j < len(row) {
				r[col.Name] = row[j]
			}
		}
		rows[i] = r
	}

	data, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ─── ClickHouse 特有方法 ───

// PartitionInfo 分区信息
type PartitionInfo struct {
	Partition   string `json:"partition" db:"partition"`
	Name        string `json:"name" db:"name"`
	Rows        int64  `json:"rows" db:"rows"`
	SizeInBytes int64  `json:"sizeInBytes" db:"size_in_bytes"`
}

// MergeTreeInfo MergeTree 引擎信息
type MergeTreeInfo struct {
	Engine       string `json:"engine" db:"engine"`
	SortingKey   string `json:"sortingKey" db:"sorting_key"`
	PartitionKey string `json:"partitionKey" db:"partition_key"`
	PrimaryKey   string `json:"primaryKey" db:"primary_key"`
}

// GetPartitions 获取分区信息
func (a *ClickHouseAdapter) GetPartitions(database, table string) ([]PartitionInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT partition, name, rows, size_in_bytes 
		FROM system.parts 
		WHERE database = ? AND table = ? AND active = 1
		ORDER BY partition`
	var partitions []PartitionInfo
	err := a.db.Select(&partitions, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("get partitions: %w", err)
	}
	return partitions, nil
}

// GetMergeTreeInfo 获取 MergeTree 引擎信息
func (a *ClickHouseAdapter) GetMergeTreeInfo(database, table string) (*MergeTreeInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT engine, sorting_key, partition_key, primary_key
		FROM system.tables 
		WHERE database = ? AND table = ?`
	var info MergeTreeInfo
	err := a.db.Get(&info, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("get merge tree info: %w", err)
	}
	return &info, nil
}

// TableStats 表统计信息
type TableStats struct {
	RowCount    int64  `json:"rowCount"`
	TotalRows   int64  `json:"totalRows"`
	TotalBytes  int64  `json:"totalBytes"`
	Engine      string `json:"engine"`
}

// GetTableStats 获取表统计
func (a *ClickHouseAdapter) GetTableStats(database, table string) (*TableStats, error) {
	if database == "" {
		database = a.conn.Database
	}

	var stats TableStats
	query := `SELECT total_rows, total_bytes, engine 
		FROM system.tables 
		WHERE database = ? AND table = ?`
	err := a.db.Get(&stats, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("get table stats: %w", err)
	}
	stats.RowCount = stats.TotalRows
	return &stats, nil
}
```

- [ ] **Step 8: Commit**

```bash
git add sidecar/adapters/clickhouse.go
git commit -m "feat(sidecar): add ClickHouse adapter with full MySQL parity"
```

---

### Task 2: Go Sidecar — 连接池 + 依赖

**Files:**
- Modify: `sidecar/pool/manager.go:13-18`
- Modify: `sidecar/go.mod`

- [ ] **Step 1: 在 pool/manager.go 添加 ConnTypeClickHouse**

在 `ConnType` 常量块中添加一行：

```go
const (
	ConnMySQL  ConnType = "mysql"
	ConnRedis  ConnType = "redis"
	ConnDocker ConnType = "docker"
	ConnES     ConnType = "elasticsearch"
	ConnCH     ConnType = "clickhouse"
)
```

- [ ] **Step 2: 添加 clickhouse-go 依赖**

```bash
cd sidecar && go get github.com/ClickHouse/clickhouse-go/v2
```

- [ ] **Step 3: 验证编译**

```bash
cd sidecar && go build ./...
```

- [ ] **Step 4: Commit**

```bash
git add sidecar/pool/manager.go sidecar/go.mod sidecar/go.sum
git commit -m "feat(sidecar): add clickhouse connection type and go dependency"
```

---

### Task 3: Go Sidecar — RPC Handlers

**Files:**
- Modify: `sidecar/adapters/handlers.go:42-43` (在 MySQL 和 Redis 之间插入)

- [ ] **Step 1: 添加 getClickHouseAdapter 辅助函数**

在 `getMySQLAdapter` 函数之后添加：

```go
func getClickHouseAdapter(mgr *pool.Manager, connID string) (*ClickHouseAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnCH {
		return nil, fmt.Errorf("connection %s is not ClickHouse (type=%s)", connID, info.Type)
	}
	return adapter.(*ClickHouseAdapter), nil
}
```

- [ ] **Step 2: 在 RegisterDBHandlers 中添加 ClickHouse 注册**

在 `// Redis` 之前插入：

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

- [ ] **Step 3: 添加所有 ClickHouse handler 函数**

在 `// ─── Redis Handlers ───` 之前插入完整的 ClickHouse handlers（模式与 MySQL 完全一致，替换 `getMySQLAdapter` → `getClickHouseAdapter`，`pool.ConnMySQL` → `pool.ConnCH`，`MySQLConnInfo` → `ClickHouseConnInfo`，`NewMySQLAdapter` → `NewClickHouseAdapter`）。

关键差异：
- `handleClickHouseConnect`: connID 前缀 `clickhouse_`，`pool.ConnCH`
- `handleClickHouseExecute`: 不需要 `USE db;` 前缀（ClickHouse 通过 DSN 指定 database）
- `handleClickHouseGetPartitions` / `handleClickHouseGetMergeTreeInfo` / `handleClickHouseGetTableStats`: ClickHouse 特有 handler

完整 handler 代码参考 MySQL handlers 模式，每个 handler 的结构完全一致。

- [ ] **Step 4: 验证编译**

```bash
cd sidecar && go build ./...
```

- [ ] **Step 5: Commit**

```bash
git add sidecar/adapters/handlers.go
git commit -m "feat(sidecar): register ClickHouse RPC handlers"
```

---

### Task 4: Rust — Tauri Commands

**Files:**
- Modify: `src-tauri/src/commands/db.rs` (文件末尾追加)
- Modify: `src-tauri/src/main.rs:140-141`

- [ ] **Step 1: 在 db.rs 末尾追加 ClickHouse commands**

在 `db_es_scroll_search` 函数之后追加：

```rust
// ─── ClickHouse Commands ───

#[tauri::command]
pub async fn db_clickhouse_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.clickhouse.connect", params).await
}

#[tauri::command]
pub async fn db_clickhouse_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.clickhouse.test", params).await
}

#[tauri::command]
pub async fn db_clickhouse_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.clickhouse.disconnect", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_clickhouse_list_databases(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.clickhouse.listDatabases", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_clickhouse_list_tables(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.listTables", params).await
}

#[tauri::command]
pub async fn db_clickhouse_list_columns(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.listColumns", params).await
}

#[tauri::command]
pub async fn db_clickhouse_list_indexes(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.listIndexes", params).await
}

#[tauri::command]
pub async fn db_clickhouse_create_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    index_name: String,
    columns: Vec<String>,
    unique: bool,
    index_type: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "indexName": index_name,
        "columns": columns,
        "unique": unique,
        "indexType": index_type,
    });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.createIndex", params).await
}

#[tauri::command]
pub async fn db_clickhouse_drop_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    index_name: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "indexName": index_name,
    });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.dropIndex", params).await
}

#[tauri::command]
pub async fn db_clickhouse_execute(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    sql: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "sql": sql });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.execute", params).await
}

#[tauri::command]
pub async fn db_clickhouse_explain(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    sql: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "sql": sql });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.explain", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_table_ddl(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.getTableDDL", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_table_data(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    limit: Option<i64>,
    offset: Option<i64>,
    order_by: Option<String>,
    order_dir: Option<String>,
    database: Option<String>,
    filter: Option<String>,
    column_filters: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(l) = limit { params["limit"] = serde_json::json!(l); }
    if let Some(o) = offset { params["offset"] = serde_json::json!(o); }
    if let Some(ob) = order_by { params["orderBy"] = serde_json::json!(ob); }
    if let Some(od) = order_dir { params["orderDir"] = serde_json::json!(od); }
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    if let Some(f) = &filter { params["filter"] = serde_json::json!(f); }
    if let Some(cf) = &column_filters { params["columnFilters"] = serde_json::json!(cf); }
    sidecar.call("db.clickhouse.getTableData", params).await
}

#[tauri::command]
pub async fn db_clickhouse_drop_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    if_exists: Option<bool>,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "ifExists": if_exists.unwrap_or(false)
    });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.dropTable", params).await
}

#[tauri::command]
pub async fn db_clickhouse_truncate_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.truncateTable", params).await
}

#[tauri::command]
pub async fn db_clickhouse_rename_table(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    old_name: String,
    new_name: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "oldName": old_name,
        "newName": new_name
    });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.renameTable", params).await
}

#[tauri::command]
pub async fn db_clickhouse_insert_row(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    values: Value,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "values": values
    });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.insertRow", params).await
}

#[tauri::command]
pub async fn db_clickhouse_update_rows(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    sets: Value,
    where_clause: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "sets": sets,
        "where": where_clause
    });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.updateRows", params).await
}

#[tauri::command]
pub async fn db_clickhouse_delete_rows(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    where_clause: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({
        "connId": conn_id,
        "table": table,
        "where": where_clause
    });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.deleteRows", params).await
}

#[tauri::command]
pub async fn db_clickhouse_export_data(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    format: String,
    limit: Option<i64>,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table, "format": format });
    if let Some(l) = limit { params["limit"] = serde_json::json!(l); }
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.exportData", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_row_count(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.getRowCount", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_table_meta(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database {
        params["database"] = serde_json::Value::String(db);
    }
    sidecar.call("db.clickhouse.getTableMeta", params).await
}

// ClickHouse 特有
#[tauri::command]
pub async fn db_clickhouse_get_partitions(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.getPartitions", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_merge_tree_info(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.getMergeTreeInfo", params).await
}

#[tauri::command]
pub async fn db_clickhouse_get_table_stats(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    table: String,
    database: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "table": table });
    if let Some(db) = database { params["database"] = serde_json::json!(db); }
    sidecar.call("db.clickhouse.getTableStats", params).await
}
```

- [ ] **Step 2: 在 main.rs 注册 ClickHouse commands**

在 `commands::db::db_es_scroll_search,` 之后添加：

```rust
            // ClickHouse
            commands::db::db_clickhouse_connect,
            commands::db::db_clickhouse_test,
            commands::db::db_clickhouse_disconnect,
            commands::db::db_clickhouse_list_databases,
            commands::db::db_clickhouse_list_tables,
            commands::db::db_clickhouse_list_columns,
            commands::db::db_clickhouse_list_indexes,
            commands::db::db_clickhouse_create_index,
            commands::db::db_clickhouse_drop_index,
            commands::db::db_clickhouse_execute,
            commands::db::db_clickhouse_explain,
            commands::db::db_clickhouse_get_table_ddl,
            commands::db::db_clickhouse_get_table_data,
            commands::db::db_clickhouse_drop_table,
            commands::db::db_clickhouse_truncate_table,
            commands::db::db_clickhouse_rename_table,
            commands::db::db_clickhouse_insert_row,
            commands::db::db_clickhouse_update_rows,
            commands::db::db_clickhouse_delete_rows,
            commands::db::db_clickhouse_export_data,
            commands::db::db_clickhouse_get_row_count,
            commands::db::db_clickhouse_get_table_meta,
            commands::db::db_clickhouse_get_partitions,
            commands::db::db_clickhouse_get_merge_tree_info,
            commands::db::db_clickhouse_get_table_stats,
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/db.rs src-tauri/src/main.rs
git commit -m "feat(tauri): add ClickHouse Tauri commands"
```

---

### Task 5: 前端 — 类型 + 服务 + Store

**Files:**
- Modify: `src/types/db.ts:1`
- Modify: `src/types/asset.ts:3`
- Modify: `src/services/db.ts`
- Modify: `src/stores/db.ts`

- [ ] **Step 1: 更新 src/types/db.ts — 添加 ClickHouseConnectParams**

在 `RedisConnectParams` 之后添加：

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

更新 `DatabaseType`（注意：db.ts 和 asset.ts 各有一份，都需要改）：

```typescript
export type DatabaseType = 'mysql' | 'redis' | 'elasticsearch' | 'clickhouse'
```

- [ ] **Step 2: 更新 src/types/asset.ts — DatabaseType 新增 clickhouse**

```typescript
export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis' | 'elasticsearch' | 'clickhouse'
```

- [ ] **Step 3: 更新 src/services/db.ts — 添加 ClickHouse 服务函数**

在 `// ─── Elasticsearch ───` 之前添加：

```typescript
// ─── ClickHouse ───

export async function clickhouseConnect(params: ClickHouseConnectParams): Promise<DbConnectionInfo> {
  return invoke('db_clickhouse_connect', { params })
}

export async function clickhouseTest(params: ClickHouseConnectParams): Promise<TestResult> {
  return invoke('db_clickhouse_test', { params })
}

export async function clickhouseDisconnect(connId: string): Promise<void> {
  return invoke('db_clickhouse_disconnect', { connId })
}

export async function clickhouseListDatabases(connId: string): Promise<string[]> {
  return invoke('db_clickhouse_list_databases', { connId })
}

export async function clickhouseListTables(connId: string, database?: string): Promise<TableInfo[]> {
  return invoke('db_clickhouse_list_tables', { connId, database })
}

export async function clickhouseListColumns(connId: string, table: string, database?: string): Promise<ColumnMeta[]> {
  return invoke('db_clickhouse_list_columns', { connId, table, database })
}

export async function clickhouseListIndexes(connId: string, table: string, database?: string): Promise<IndexInfo[]> {
  return invoke('db_clickhouse_list_indexes', { connId, table, database })
}

export async function clickhouseCreateIndex(
  connId: string, table: string, indexName: string, columns: string[],
  unique: boolean, indexType: string, database?: string
): Promise<void> {
  return invoke('db_clickhouse_create_index', { connId, table, indexName, columns, unique, indexType, database })
}

export async function clickhouseDropIndex(connId: string, table: string, indexName: string, database?: string): Promise<void> {
  return invoke('db_clickhouse_drop_index', { connId, table, indexName, database })
}

export async function clickhouseExecute(connId: string, sql: string, database?: string): Promise<QueryResult> {
  return invoke('db_clickhouse_execute', { connId, sql, database })
}

export async function clickhouseExplain(connId: string, sql: string, database?: string): Promise<QueryResult> {
  return invoke('db_clickhouse_explain', { connId, sql, database })
}

export async function clickhouseGetTableDDL(connId: string, table: string, database?: string): Promise<DDLResult> {
  return invoke('db_clickhouse_get_table_ddl', { connId, table, database })
}

export async function clickhouseGetTableData(
  connId: string, table: string, limit?: number, offset?: number,
  orderBy?: string, orderDir?: string, database?: string,
  filter?: string, columnFilters?: Record<string, string>
): Promise<QueryResult> {
  return invoke('db_clickhouse_get_table_data', { connId, table, limit, offset, orderBy, orderDir, database, filter, columnFilters })
}

export async function clickhouseDropTable(connId: string, table: string, ifExists?: boolean, database?: string): Promise<void> {
  return invoke('db_clickhouse_drop_table', { connId, table, ifExists, database })
}

export async function clickhouseTruncateTable(connId: string, table: string, database?: string): Promise<void> {
  return invoke('db_clickhouse_truncate_table', { connId, table, database })
}

export async function clickhouseRenameTable(connId: string, oldName: string, newName: string, database?: string): Promise<void> {
  return invoke('db_clickhouse_rename_table', { connId, oldName, newName, database })
}

export async function clickhouseInsertRow(connId: string, table: string, values: Record<string, unknown>, database?: string): Promise<InsertResult> {
  return invoke('db_clickhouse_insert_row', { connId, table, values, database })
}

export async function clickhouseUpdateRows(connId: string, table: string, sets: Record<string, unknown>, where: string, database?: string): Promise<RowsAffectedResult> {
  return invoke('db_clickhouse_update_rows', { connId, table, sets, whereClause: where, database })
}

export async function clickhouseDeleteRows(connId: string, table: string, where: string, database?: string): Promise<RowsAffectedResult> {
  return invoke('db_clickhouse_delete_rows', { connId, table, whereClause: where, database })
}

export async function clickhouseExportData(connId: string, table: string, format: string, limit?: number, database?: string): Promise<ExportResult> {
  return invoke('db_clickhouse_export_data', { connId, table, format, limit, database })
}

export async function clickhouseGetRowCount(connId: string, table: string, database?: string): Promise<RowCountResult> {
  return invoke('db_clickhouse_get_row_count', { connId, table, database })
}

export async function clickhouseGetTableMeta(connId: string, table: string, database?: string): Promise<TableMetaResult> {
  return invoke('db_clickhouse_get_table_meta', { connId, table, database })
}

// ClickHouse 特有
export async function clickhouseGetPartitions(connId: string, table: string, database?: string): Promise<unknown[]> {
  return invoke('db_clickhouse_get_partitions', { connId, table, database })
}

export async function clickhouseGetMergeTreeInfo(connId: string, table: string, database?: string): Promise<unknown> {
  return invoke('db_clickhouse_get_merge_tree_info', { connId, table, database })
}

export async function clickhouseGetTableStats(connId: string, table: string, database?: string): Promise<unknown> {
  return invoke('db_clickhouse_get_table_stats', { connId, table, database })
}
```

同时更新 import 语句，添加 `ClickHouseConnectParams`。

- [ ] **Step 4: 更新 src/stores/db.ts — 添加 connectClickHouse**

在 `connectElasticsearch` 函数之后添加：

```typescript
async function connectClickHouse(assetId: string, name: string, params: {
  host: string
  port: number
  username: string
  password: string
  database?: string
  ssl?: boolean
}): Promise<DbSession> {
  const info = await dbService.clickhouseConnect(params)
  const session: DbSession = {
    connId: info.connId,
    dbType: 'clickhouse',
    host: info.host,
    port: info.port,
    database: info.database || '',
    connected: true,
    name,
    assetId
  }
  sessions.value.set(info.connId, session)
  currentConnId.value = info.connId
  return session
}
```

在 `disconnect` 函数中添加 ClickHouse 分支：

```typescript
} else if (session.dbType === 'clickhouse') {
  await dbService.clickhouseDisconnect(connId)
}
```

在 return 对象中添加 `connectClickHouse`。

- [ ] **Step 5: Commit**

```bash
git add src/types/db.ts src/types/asset.ts src/services/db.ts src/stores/db.ts
git commit -m "feat(frontend): add ClickHouse types, services, and store"
```

---

### Task 6: 前端 — 路由 + 连接表单 + DbView

**Files:**
- Modify: `src/router/index.ts:44`
- Modify: `src/components/db/DbConnectionForm.vue`
- Modify: `src/views/DbView.vue`

- [ ] **Step 1: 在 router/index.ts 添加 ClickHouse 路由**

在 `db/elasticsearch/:id` 路由之后添加：

```typescript
{
  path: 'db/clickhouse/:id',
  name: 'db-clickhouse',
  component: () => import('@/views/DbView.vue'),
  props: true,
},
```

- [ ] **Step 2: 更新 DbConnectionForm.vue — 添加 ClickHouse 类型选项**

在 `db-type-switcher` 中添加 ClickHouse 按钮（在 Elasticsearch 按钮之后）：

```html
<div
  class="db-type-btn"
  :class="{ active: dbType === 'clickhouse' }"
  @click="dbType = 'clickhouse'"
>
  <v-icon size="16">mdi-database</v-icon>
  <span>ClickHouse</span>
</div>
```

在 `watch(dbType, ...)` 中添加 ClickHouse 端口：

```typescript
} else if (type === 'clickhouse') {
  port.value = 9000
}
```

在 `watch(initialValues, ...)` 中更新默认端口逻辑：

```typescript
port.value = next.port ?? (next.dbType === 'redis' ? 6379 : next.dbType === 'elasticsearch' ? 9200 : next.dbType === 'clickhouse' ? 9000 : 3306)
```

在 `canSubmit` / `canTest` 中添加 ClickHouse 判断（与 MySQL 相同，需要 username）：

```typescript
if (dbType.value === 'clickhouse') return !!username.value
```

在 `onTestConnection` 中添加 ClickHouse 测试分支：

```typescript
} else if (dbType.value === 'clickhouse') {
  const result = await dbService.clickhouseTest({
    host: host.value,
    port: port.value,
    username: username.value,
    password: password.value,
    database: database.value || undefined,
    ssl: ssl.value
  })
  testStatus.value = result.ok ? 'success' : 'fail'
  testMessage.value = result.message
}
```

在 `onSubmit` 中添加 ClickHouse 提交分支（与 MySQL 模式一致）。

更新 port placeholder：

```html
:placeholder="dbType === 'mysql' ? '3306' : dbType === 'clickhouse' ? '9000' : '6379'"
```

- [ ] **Step 3: 更新 DbView.vue — 添加 ClickHouse 连接分支**

在 `connect()` 函数中，在 `else if (dbType === 'redis')` 之前添加：

```typescript
} else if (dbType === 'clickhouse') {
  const session = await dbStore.connectClickHouse(assetId.value, asset.value.name, {
    host: config.host || '',
    port: config.port || 9000,
    username: config.username || '',
    password: config.password || '',
    database: config.database,
    ssl: config.ssl
  })
  connId.value = session.connId
  connected.value = true

  try {
    databases.value = await dbService.clickhouseListDatabases(session.connId)
    if (config.database && databases.value.includes(config.database)) {
      selectedDb.value = config.database
    }
  } catch (err) {
    const msg = errMsg(err)
    console.warn('[db] list databases failed:', err)
    notify.notify({ message: t('db.listDbFailed', { msg }), color: 'warning' })
  }
}
```

在 DbView.vue 中搜索所有 `dbType === 'mysql'` 的分支，添加对应的 `dbType === 'clickhouse'` 分支。关键位置：
- SQL 执行：使用 `clickhouseExecute` 替代 `mysqlExecute`
- 表操作：使用 `clickhouse*` 系列函数
- SQL 方言：`dialect` 传 `'mysql'`（ClickHouse SQL 与 MySQL 方言在 CodeMirror 中可复用）

- [ ] **Step 4: Commit**

```bash
git add src/router/index.ts src/components/db/DbConnectionForm.vue src/views/DbView.vue
git commit -m "feat(frontend): add ClickHouse route, connection form, and DbView integration"
```

---

### Task 7: 样式 — ClickHouse 连接图标色块

**Files:**
- Modify: `src/styles/cyber.css`

- [ ] **Step 1: 添加 .connection-icon.clickhouse 样式**

在 `.connection-icon.elasticsearch` 样式块之后添加：

```css
.connection-icon.clickhouse {
  background: linear-gradient(135deg, #fadb14 0%, #d4b106 100%);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles/cyber.css
git commit -m "style: add ClickHouse connection icon color"
```

---

### Task 8: 验证 + 最终提交

- [ ] **Step 1: 验证 Go sidecar 编译**

```bash
cd sidecar && go build ./...
```

- [ ] **Step 2: 验证 Rust 编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 3: 验证前端 TypeScript**

```bash
cd src && npx vue-tsc --noEmit
```

- [ ] **Step 4: 更新 CHANGELOG.md**

在 `[未发布]` 下添加：

```markdown
- ✨ feat(db): 新增 ClickHouse 数据库连接支持（功能完全对齐 MySQL + 特有元数据）
```

- [ ] **Step 5: 最终 Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG for ClickHouse support"
```
