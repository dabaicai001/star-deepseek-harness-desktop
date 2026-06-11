package adapters

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jmoiron/sqlx"
	"github.com/rs/zerolog/log"
)

// MySQLAdapter 封装 MySQL 连接
type MySQLAdapter struct {
	db   *sqlx.DB
	conn *MySQLConnInfo
}

// MySQLConnInfo MySQL 连接参数
type MySQLConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database,omitempty"`
	SSL      bool   `json:"ssl,omitempty"`
}

// QueryResult 查询结果
type QueryResult struct {
	Columns      []ColumnInfo       `json:"columns"`
	Rows         [][]interface{}    `json:"rows"`
	RowsAffected int64              `json:"rowsAffected"`
	LastInsertID int64              `json:"lastInsertId,omitempty"`
	DurationMs   int64              `json:"durationMs"`
	IsSelect     bool               `json:"isSelect"`
	Error        string             `json:"error,omitempty"`
	TotalRows    int64              `json:"totalRows,omitempty"`
}

// ColumnInfo 列信息
type ColumnInfo struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
}

// TableInfo 表信息
type TableInfo struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Engine  string `json:"engine,omitempty"`
	Rows    int64  `json:"rows,omitempty"`
	Comment string `json:"comment,omitempty"`
}

// ColumnMeta 列元数据
type ColumnMeta struct {
	Name         string `json:"name" db:"COLUMN_NAME"`
	Type         string `json:"type" db:"COLUMN_TYPE"`
	DataType     string `json:"dataType" db:"DATA_TYPE"`
	Nullable     string `json:"nullable" db:"IS_NULLABLE"`
	Key          string `json:"key" db:"COLUMN_KEY"`
	DefaultValue *string `json:"defaultValue" db:"COLUMN_DEFAULT"`
	Extra        string `json:"extra" db:"EXTRA"`
	Comment      string `json:"comment" db:"COLUMN_COMMENT"`
	OrdinalPos   int    `json:"ordinalPosition" db:"ORDINAL_POSITION"`
}

// IndexInfo 索引信息
type IndexInfo struct {
	TableName   string `json:"tableName" db:"Table"`
	NonUnique   int    `json:"nonUnique" db:"Non_unique"`
	KeyName     string `json:"keyName" db:"Key_name"`
	SeqInIndex  int    `json:"seqInIndex" db:"Seq_in_index"`
	ColumnName  string `json:"columnName" db:"Column_name"`
	Collation   string `json:"collation" db:"Collation"`
	Cardinality *int64 `json:"cardinality" db:"Cardinality"`
	SubPart     *int64 `json:"subPart" db:"Sub_part"`
	Packed      *string `json:"packed" db:"Packed"`
	Null        string `json:"null" db:"Null"`
	IndexType   string `json:"indexType" db:"Index_type"`
	Comment     string `json:"comment" db:"Comment"`
	IndexComment string `json:"indexComment" db:"Index_comment"`
	Visible     string `json:"visible" db:"Visible"`
	Expression  *string `json:"expression" db:"Expression"`
}

// TableMeta 表元信息（列 + 行数，一次请求并行获取）
type TableMeta struct {
	Columns  []ColumnMeta `json:"columns"`
	RowCount int64        `json:"rowCount"`
}

// NewMySQLAdapter 创建 MySQL 适配器
func NewMySQLAdapter(info *MySQLConnInfo) (*MySQLAdapter, error) {
	if info.Port == 0 {
		info.Port = 3306
	}

	cfg := mysql.Config{
		User:                 info.Username,
		Passwd:               info.Password,
		Net:                  "tcp",
		Addr:                 fmt.Sprintf("%s:%d", info.Host, info.Port),
		DBName:               info.Database,
		AllowNativePasswords: true,
		MultiStatements:      true,
		ParseTime:            true,
		Timeout:              10 * time.Second,
		ReadTimeout:          30 * time.Second,
		WriteTimeout:         30 * time.Second,
		Loc:                  time.UTC,
	}

	if info.SSL {
		cfg.TLSConfig = "true"
	}

	db, err := sqlx.Connect("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, fmt.Errorf("mysql connect failed: %w", err)
	}

	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)

	log.Info().Str("host", info.Host).Int("port", info.Port).Str("db", info.Database).Msg("mysql connected")

	return &MySQLAdapter{db: db, conn: info}, nil
}

// Close 关闭连接
func (a *MySQLAdapter) Close() error {
	return a.db.Close()
}

// Ping 检测连接
func (a *MySQLAdapter) Ping() error {
	return a.db.Ping()
}

// ListDatabases 列出所有数据库
func (a *MySQLAdapter) ListDatabases() ([]string, error) {
	var dbs []string
	err := a.db.Select(&dbs, "SHOW DATABASES")
	if err != nil {
		return nil, fmt.Errorf("list databases: %w", err)
	}
	return dbs, nil
}

// ListTables 列出当前数据库的所有表
func (a *MySQLAdapter) ListTables(database string) ([]TableInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT TABLE_NAME as name, TABLE_TYPE as type, 
		COALESCE(ENGINE, '') as engine, 
		COALESCE(TABLE_ROWS, 0) as rows, 
		COALESCE(TABLE_COMMENT, '') as comment 
		FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`
	var tables []TableInfo
	err := a.db.Select(&tables, query, database)
	if err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	return tables, nil
}

// ListColumns 列出表的所有列
func (a *MySQLAdapter) ListColumns(database, table string) ([]ColumnMeta, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := `SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_KEY,
		COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
		FROM information_schema.COLUMNS 
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		ORDER BY ORDINAL_POSITION`
	var cols []ColumnMeta
	err := a.db.Select(&cols, query, database, table)
	if err != nil {
		return nil, fmt.Errorf("list columns: %w", err)
	}
	return cols, nil
}

// ListIndexes 列出表的索引
func (a *MySQLAdapter) ListIndexes(database, table string) ([]IndexInfo, error) {
	if database == "" {
		database = a.conn.Database
	}
	var indexes []IndexInfo
	err := a.db.Select(&indexes, fmt.Sprintf("SHOW INDEX FROM `%s`.`%s`", database, table))
	if err != nil {
		return nil, fmt.Errorf("list indexes: %w", err)
	}
	return indexes, nil
}

// CreateIndex 创建索引
func (a *MySQLAdapter) CreateIndex(database, table, indexName string, columns []string, unique bool, indexType string) error {
	if database == "" {
		database = a.conn.Database
	}
	if indexType == "" {
		indexType = "BTREE"
	}
	cols := make([]string, len(columns))
	for i, c := range columns {
		cols[i] = fmt.Sprintf("`%s`", c)
	}
	uniqueStr := ""
	if unique {
		uniqueStr = "UNIQUE "
	}
	query := fmt.Sprintf("CREATE %sINDEX `%s` ON `%s`.`%s` (%s) USING %s",
		uniqueStr, indexName, database, table, strings.Join(cols, ", "), indexType)
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("create index: %w", err)
	}
	return nil
}

// DropIndex 删除索引
func (a *MySQLAdapter) DropIndex(database, table, indexName string) error {
	if database == "" {
		database = a.conn.Database
	}
	query := fmt.Sprintf("DROP INDEX `%s` ON `%s`.`%s`", indexName, database, table)
	_, err := a.db.Exec(query)
	if err != nil {
		return fmt.Errorf("drop index: %w", err)
	}
	return nil
}

// Execute 执行 SQL（支持多语句分号分割）
func (a *MySQLAdapter) Execute(sqlStr string) (*QueryResult, error) {
	start := time.Now()

	sqlStr = strings.TrimSpace(sqlStr)
	if sqlStr == "" {
		return &QueryResult{Error: "empty SQL"}, nil
	}

	// 判断是否是 SELECT 查询（跳过前置的 USE db; 语句）
	checkStr := sqlStr
	upper := strings.ToUpper(sqlStr)
	if strings.HasPrefix(upper, "USE ") {
		if idx := strings.Index(sqlStr, ";"); idx != -1 {
			checkStr = strings.TrimSpace(sqlStr[idx+1:])
		}
	}
	upperCheck := strings.ToUpper(checkStr)
	isSelect := strings.HasPrefix(upperCheck, "SELECT") ||
		strings.HasPrefix(upperCheck, "SHOW") ||
		strings.HasPrefix(upperCheck, "DESCRIBE") ||
		strings.HasPrefix(upperCheck, "EXPLAIN")

	if isSelect {
		if !regexp.MustCompile(`(?i)\bLIMIT\s+\d+`).MatchString(checkStr) && !isSafeSystemQuery(checkStr) {
			sqlStr = sqlStr + " LIMIT 100"
		}
		return a.executeSelect(sqlStr, start)
	}
	return a.executeExec(sqlStr, start)
}

// isSafeSystemQuery 判断是否是已知有界 / 系统级 SHOW 查询,无需 LIMIT 保护。
// 这些语句返回行数固定有限(最多几百行),不会被恶意拉爆;同时仪表盘
// `SHOW GLOBAL STATUS` / `SHOW GLOBAL VARIABLES` 包含 400+ 个 status 变量,
// 强行 LIMIT 100 会把 `Threads_connected` / `Uptime` / `Queries` 等关键
// 指标全部截断,导致仪表盘数字全 0。
func isSafeSystemQuery(sqlStr string) bool {
	upper := strings.ToUpper(strings.TrimSpace(sqlStr))
	patterns := []string{
		"SHOW GLOBAL STATUS",
		"SHOW GLOBAL VARIABLES",
		"SHOW SESSION STATUS",
		"SHOW SESSION VARIABLES",
		"SHOW STATUS",
		"SHOW VARIABLES",
		"SHOW ENGINE INNODB STATUS",
		"SHOW ENGINE INNODB MUTEX",
		"SHOW ENGINE INNODB SYS",
		"SHOW MASTER STATUS",
		"SHOW SLAVE STATUS",
		"SHOW REPLICA STATUS",
		"SHOW BINARY LOGS",
		"SHOW BINLOG EVENTS",
		"SHOW PROCESSLIST",
		"SHOW FULL PROCESSLIST",
		"SHOW GRANTS",
		"SHOW PRIVILEGES",
		"SHOW EVENTS",
		"SHOW TRIGGERS",
		"SHOW PROCEDURE STATUS",
		"SHOW FUNCTION STATUS",
		"SHOW TABLE STATUS",
		"SHOW WARNINGS",
		"SHOW ERRORS",
		"SHOW PLUGINS",
		"SHOW ENGINES",
		"SHOW CHARSET",
		"SHOW COLLATION",
	}
	for _, p := range patterns {
		if strings.HasPrefix(upper, p) {
			return true
		}
	}
	return false
}

func (a *MySQLAdapter) executeSelect(sqlStr string, start time.Time) (*QueryResult, error) {
	return a.executeSelectArgs(sqlStr, nil, start)
}

func (a *MySQLAdapter) executeSelectArgs(sqlStr string, args []interface{}, start time.Time) (*QueryResult, error) {
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
		// 转换 []byte 为 string
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

func (a *MySQLAdapter) executeExec(sqlStr string, start time.Time) (*QueryResult, error) {
	result, err := a.db.Exec(sqlStr)
	if err != nil {
		return &QueryResult{
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}, nil
	}

	affected, _ := result.RowsAffected()
	lastID, _ := result.LastInsertId()

	return &QueryResult{
		RowsAffected: affected,
		LastInsertID: lastID,
		DurationMs:   time.Since(start).Milliseconds(),
	}, nil
}

// Explain 获取执行计划
func (a *MySQLAdapter) Explain(sqlStr string) (*QueryResult, error) {
	return a.executeSelect("EXPLAIN "+sqlStr, time.Now())
}

// GetTableDDL 获取建表 DDL
func (a *MySQLAdapter) GetTableDDL(database, table string) (string, error) {
	if database == "" {
		database = a.conn.Database
	}
	var tableName, ddl string
	err := a.db.QueryRow(fmt.Sprintf("SHOW CREATE TABLE `%s`.`%s`", database, table)).Scan(&tableName, &ddl)
	if err != nil {
		return "", fmt.Errorf("get ddl: %w", err)
	}
	return ddl, nil
}

// GetTableData 分页获取表数据
// filter: 全局文本搜索,对所有文本列做 LIKE 匹配
// columnFilters: 精确列筛选,对指定列做 = 匹配
func (a *MySQLAdapter) GetTableData(database, table string, limit, offset int, orderBy, orderDir, filter string, columnFilters map[string]string) (*QueryResult, error) {
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

	// Build WHERE clause from filters
	var conditions []string
	var args []interface{}

	// 全局文本搜索:对所有文本列做 LIKE
	if filter != "" {
		cols, err := a.ListColumns(database, table)
		if err == nil {
			var textConds []string
			for _, c := range cols {
				typeLower := strings.ToLower(c.Type)
				if strings.Contains(typeLower, "char") ||
					strings.Contains(typeLower, "text") ||
					strings.Contains(typeLower, "enum") ||
					strings.Contains(typeLower, "set") {
					textConds = append(textConds, fmt.Sprintf("`%s` LIKE ?", c.Name))
					args = append(args, "%"+filter+"%")
				}
			}
			if len(textConds) > 0 {
				conditions = append(conditions, "("+strings.Join(textConds, " OR ")+")")
			}
		}
	}

	// 精确列筛选
	if len(columnFilters) > 0 {
		for col, val := range columnFilters {
			conditions = append(conditions, fmt.Sprintf("`%s` = ?", col))
			args = append(args, val)
		}
	}

	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
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
	if len(args) > 0 {
		result, _ = a.executeSelectArgs(query, args, time.Now())
	} else {
		result, _ = a.executeSelect(query, time.Now())
	}

	// When filters are active, also return filtered row count for pagination
	if len(conditions) > 0 {
		countQuery := fmt.Sprintf("SELECT COUNT(*) FROM `%s`.`%s`", database, table)
		countQuery += " WHERE " + strings.Join(conditions, " AND ")
		var totalRows int64
		if len(args) > 0 {
			a.db.Get(&totalRows, countQuery, args...)
		} else {
			a.db.Get(&totalRows, countQuery)
		}
		result.TotalRows = totalRows
	}

	return result, nil
}

// GetRowCount 获取表行数
func (a *MySQLAdapter) GetRowCount(database, table string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	var count int64
	err := a.db.Get(&count, fmt.Sprintf("SELECT COUNT(*) FROM `%s`.`%s`", database, table))
	return count, err
}

// GetTableMeta 批量获取表元信息（列元数据 + 行数），并行查询减少延迟
func (a *MySQLAdapter) GetTableMeta(database, table string) (*TableMeta, error) {
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

// DropTable 删除表
func (a *MySQLAdapter) DropTable(database, table string, ifExists bool) error {
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
func (a *MySQLAdapter) TruncateTable(database, table string) error {
	if database == "" {
		database = a.conn.Database
	}
	_, err := a.db.Exec(fmt.Sprintf("TRUNCATE TABLE `%s`.`%s`", database, table))
	return err
}

// RenameTable 重命名表
func (a *MySQLAdapter) RenameTable(database, oldName, newName string) error {
	if database == "" {
		database = a.conn.Database
	}
	_, err := a.db.Exec(fmt.Sprintf("RENAME TABLE `%s`.`%s` TO `%s`.`%s`", database, oldName, database, newName))
	return err
}

// UpdateRows 批量更新行
func (a *MySQLAdapter) UpdateRows(database, table string, sets map[string]interface{}, where string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	setParts := make([]string, 0, len(sets))
	args := make([]interface{}, 0, len(sets))
	for col, val := range sets {
		setParts = append(setParts, fmt.Sprintf("`%s` = ?", col))
		args = append(args, val)
	}

	query := fmt.Sprintf("UPDATE `%s`.`%s` SET %s", database, table, strings.Join(setParts, ", "))
	if where != "" {
		query += " WHERE " + where
	}

	result, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// DeleteRows 删除行
func (a *MySQLAdapter) DeleteRows(database, table, where string) (int64, error) {
	if database == "" {
		database = a.conn.Database
	}
	query := fmt.Sprintf("DELETE FROM `%s`.`%s`", database, table)
	if where != "" {
		query += " WHERE " + where
	}
	result, err := a.db.Exec(query)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// InsertRow 插入一行
func (a *MySQLAdapter) InsertRow(database, table string, values map[string]interface{}) (int64, error) {
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
	result, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// ExportCSV 导出表为 CSV（返回 JSON 编码的结果）
func (a *MySQLAdapter) ExportCSV(database, table string, limit int) (*QueryResult, error) {
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
func (a *MySQLAdapter) ExportJSON(database, table string, limit int) (string, error) {
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
