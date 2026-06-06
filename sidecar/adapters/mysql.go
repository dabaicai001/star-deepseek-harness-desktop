package adapters

import (
	"encoding/json"
	"fmt"
	"strings"
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
	TableName  string `json:"tableName" db:"Table"`
	NonUnique  int    `json:"nonUnique" db:"Non_unique"`
	KeyName    string `json:"keyName" db:"Key_name"`
	SeqInIndex int    `json:"seqInIndex" db:"Seq_in_index"`
	ColumnName string `json:"columnName" db:"Column_name"`
	IndexType  string `json:"indexType" db:"Index_type"`
	Comment    string `json:"comment" db:"Index_comment"`
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
	query := `SELECT TABLE_NAME as name, TABLE_TYPE as type, ENGINE as engine, 
		TABLE_ROWS as rows, TABLE_COMMENT as comment 
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
func (a *MySQLAdapter) ListIndexes(table string) ([]IndexInfo, error) {
	var indexes []IndexInfo
	err := a.db.Select(&indexes, fmt.Sprintf("SHOW INDEX FROM `%s`", table))
	if err != nil {
		return nil, fmt.Errorf("list indexes: %w", err)
	}
	return indexes, nil
}

// Execute 执行 SQL（支持多语句分号分割）
func (a *MySQLAdapter) Execute(sqlStr string) (*QueryResult, error) {
	start := time.Now()

	sqlStr = strings.TrimSpace(sqlStr)
	if sqlStr == "" {
		return &QueryResult{Error: "empty SQL"}, nil
	}

	// 判断是否是 SELECT 查询
	upper := strings.ToUpper(sqlStr)
	isSelect := strings.HasPrefix(upper, "SELECT") ||
		strings.HasPrefix(upper, "SHOW") ||
		strings.HasPrefix(upper, "DESCRIBE") ||
		strings.HasPrefix(upper, "EXPLAIN")

	if isSelect {
		return a.executeSelect(sqlStr, start)
	}
	return a.executeExec(sqlStr, start)
}

func (a *MySQLAdapter) executeSelect(sqlStr string, start time.Time) (*QueryResult, error) {
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
func (a *MySQLAdapter) GetTableDDL(table string) (string, error) {
	var tableName, ddl string
	err := a.db.QueryRow(fmt.Sprintf("SHOW CREATE TABLE `%s`", table)).Scan(&tableName, &ddl)
	if err != nil {
		return "", fmt.Errorf("get ddl: %w", err)
	}
	return ddl, nil
}

// GetTableData 分页获取表数据
func (a *MySQLAdapter) GetTableData(table string, limit, offset int, orderBy, orderDir string) (*QueryResult, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 10000 {
		limit = 10000
	}

	query := fmt.Sprintf("SELECT * FROM `%s`", table)
	if orderBy != "" {
		dir := "ASC"
		if strings.ToUpper(orderDir) == "DESC" {
			dir = "DESC"
		}
		query += fmt.Sprintf(" ORDER BY `%s` %s", orderBy, dir)
	}
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)

	return a.executeSelect(query, time.Now())
}

// GetRowCount 获取表行数
func (a *MySQLAdapter) GetRowCount(table string) (int64, error) {
	var count int64
	err := a.db.Get(&count, fmt.Sprintf("SELECT COUNT(*) FROM `%s`", table))
	return count, err
}

// DropTable 删除表
func (a *MySQLAdapter) DropTable(table string, ifExists bool) error {
	stmt := "DROP TABLE"
	if ifExists {
		stmt += " IF EXISTS"
	}
	stmt += fmt.Sprintf(" `%s`", table)
	_, err := a.db.Exec(stmt)
	return err
}

// TruncateTable 清空表
func (a *MySQLAdapter) TruncateTable(table string) error {
	_, err := a.db.Exec(fmt.Sprintf("TRUNCATE TABLE `%s`", table))
	return err
}

// RenameTable 重命名表
func (a *MySQLAdapter) RenameTable(oldName, newName string) error {
	_, err := a.db.Exec(fmt.Sprintf("RENAME TABLE `%s` TO `%s`", oldName, newName))
	return err
}

// UpdateRows 批量更新行
func (a *MySQLAdapter) UpdateRows(table string, sets map[string]interface{}, where string) (int64, error) {
	setParts := make([]string, 0, len(sets))
	args := make([]interface{}, 0, len(sets))
	for col, val := range sets {
		setParts = append(setParts, fmt.Sprintf("`%s` = ?", col))
		args = append(args, val)
	}

	query := fmt.Sprintf("UPDATE `%s` SET %s", table, strings.Join(setParts, ", "))
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
func (a *MySQLAdapter) DeleteRows(table, where string) (int64, error) {
	query := fmt.Sprintf("DELETE FROM `%s`", table)
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
func (a *MySQLAdapter) InsertRow(table string, values map[string]interface{}) (int64, error) {
	cols := make([]string, 0, len(values))
	placeholders := make([]string, 0, len(values))
	args := make([]interface{}, 0, len(values))
	for col, val := range values {
		cols = append(cols, fmt.Sprintf("`%s`", col))
		placeholders = append(placeholders, "?")
		args = append(args, val)
	}

	query := fmt.Sprintf("INSERT INTO `%s` (%s) VALUES (%s)", table,
		strings.Join(cols, ", "), strings.Join(placeholders, ", "))
	result, err := a.db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// ExportCSV 导出表为 CSV（返回 JSON 编码的结果）
func (a *MySQLAdapter) ExportCSV(table string, limit int) (*QueryResult, error) {
	if limit <= 0 {
		limit = 100000
	}
	query := fmt.Sprintf("SELECT * FROM `%s` LIMIT %d", table, limit)
	return a.executeSelect(query, time.Now())
}

// ExportJSON 导出表为 JSON
func (a *MySQLAdapter) ExportJSON(table string, limit int) (string, error) {
	result, err := a.ExportCSV(table, limit)
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
