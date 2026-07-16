package adapters

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/rs/zerolog/log"
	"github.com/starhub/sidecar/pool"
)

// BackupInfo 备份文件信息
type BackupInfo struct {
	FileName   string `json:"fileName"`
	Size       int64  `json:"size"`
	ModifiedAt int64  `json:"modifiedAt"`
	Database   string `json:"database"`
	Type       string `json:"type"`
}

// BackupDatabase 根据连接类型调用 mysqldump / pg_dump 备份数据库到 outputPath。
// format 对 pg_dump 生效："sql"(默认)、"custom"、"tar"。
func BackupDatabase(mgr *pool.Manager, connID string, format string, outputPath string) error {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return err
	}

	switch info.Type {
	case pool.ConnMySQL:
		mysqlAdapter, ok := adapter.(*MySQLAdapter)
		if !ok {
			return fmt.Errorf("adapter type assertion failed for %s", connID)
		}
		return backupMySQL(mysqlAdapter.conn, outputPath)
	case pool.ConnPG:
		pgAdapter, ok := adapter.(*PostgresAdapter)
		if !ok {
			return fmt.Errorf("adapter type assertion failed for %s", connID)
		}
		return backupPostgres(pgAdapter.conn, format, outputPath)
	default:
		return fmt.Errorf("backup not supported for connection type: %s", info.Type)
	}
}

// RestoreDatabase 从 inputPath 恢复数据库（mysql / psql）。
func RestoreDatabase(mgr *pool.Manager, connID string, inputPath string) error {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return err
	}

	switch info.Type {
	case pool.ConnMySQL:
		mysqlAdapter, ok := adapter.(*MySQLAdapter)
		if !ok {
			return fmt.Errorf("adapter type assertion failed for %s", connID)
		}
		return restoreMySQL(mysqlAdapter.conn, inputPath)
	case pool.ConnPG:
		pgAdapter, ok := adapter.(*PostgresAdapter)
		if !ok {
			return fmt.Errorf("adapter type assertion failed for %s", connID)
		}
		return restorePostgres(pgAdapter.conn, inputPath)
	default:
		return fmt.Errorf("restore not supported for connection type: %s", info.Type)
	}
}

// ListBackups 列出 backupDir 下的 .sql 备份文件。
func ListBackups(backupDir string) ([]BackupInfo, error) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return nil, fmt.Errorf("read backup directory: %w", err)
	}

	var backups []BackupInfo
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext != ".sql" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		backups = append(backups, BackupInfo{
			FileName:   name,
			Size:       info.Size(),
			ModifiedAt: info.ModTime().Unix(),
		})
	}
	return backups, nil
}

// ─── MySQL ───

func backupMySQL(conn *MySQLConnInfo, outputPath string) error {
	if conn.Database == "" {
		return fmt.Errorf("database name is required for MySQL backup")
	}

	outFile, err := os.Create(outputPath)
	if err != nil {
		return fmt.Errorf("create output file: %w", err)
	}
	defer outFile.Close()

	port := conn.Port
	if port == 0 {
		port = 3306
	}

	cmd := exec.Command("mysqldump",
		"-h", conn.Host,
		"-P", fmt.Sprintf("%d", port),
		"-u", conn.Username,
		"--single-transaction",
		"--routines",
		"--triggers",
		conn.Database,
	)
	// 通过环境变量传递密码，避免出现在命令行参数 / ps 输出中
	cmd.Env = append(os.Environ(), "MYSQL_PWD="+conn.Password)
	cmd.Stdout = outFile
	cmd.Stderr = os.Stderr

	log.Info().
		Str("host", conn.Host).
		Int("port", port).
		Str("db", conn.Database).
		Str("output", outputPath).
		Msg("starting MySQL backup")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("mysqldump failed: %w", err)
	}
	return nil
}

func restoreMySQL(conn *MySQLConnInfo, inputPath string) error {
	if conn.Database == "" {
		return fmt.Errorf("database name is required for MySQL restore")
	}

	inFile, err := os.Open(inputPath)
	if err != nil {
		return fmt.Errorf("open input file: %w", err)
	}
	defer inFile.Close()

	port := conn.Port
	if port == 0 {
		port = 3306
	}

	cmd := exec.Command("mysql",
		"-h", conn.Host,
		"-P", fmt.Sprintf("%d", port),
		"-u", conn.Username,
		conn.Database,
	)
	cmd.Env = append(os.Environ(), "MYSQL_PWD="+conn.Password)
	cmd.Stdin = inFile
	cmd.Stderr = os.Stderr

	log.Info().
		Str("host", conn.Host).
		Int("port", port).
		Str("db", conn.Database).
		Str("input", inputPath).
		Msg("starting MySQL restore")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("mysql restore failed: %w", err)
	}
	return nil
}

// ─── PostgreSQL ───

func backupPostgres(conn *PostgresConnInfo, format string, outputPath string) error {
	port := conn.Port
	if port == 0 {
		port = 5432
	}
	db := conn.Database
	if db == "" {
		db = "postgres"
	}

	args := []string{
		"-h", conn.Host,
		"-p", fmt.Sprintf("%d", port),
		"-U", conn.Username,
		"-d", db,
		"-f", outputPath,
	}

	// format: "sql"(默认, -F p)、"custom"(-F c)、"tar"(-F t)
	switch strings.ToLower(format) {
	case "custom", "c":
		args = append(args, "-F", "c")
	case "tar", "t":
		args = append(args, "-F", "t")
	default:
		args = append(args, "-F", "p")
	}

	cmd := exec.Command("pg_dump", args...)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+conn.Password)
	cmd.Stderr = os.Stderr

	log.Info().
		Str("host", conn.Host).
		Int("port", port).
		Str("db", db).
		Str("format", format).
		Str("output", outputPath).
		Msg("starting PostgreSQL backup")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pg_dump failed: %w", err)
	}
	return nil
}

func restorePostgres(conn *PostgresConnInfo, inputPath string) error {
	port := conn.Port
	if port == 0 {
		port = 5432
	}
	db := conn.Database
	if db == "" {
		db = "postgres"
	}

	cmd := exec.Command("psql",
		"-h", conn.Host,
		"-p", fmt.Sprintf("%d", port),
		"-U", conn.Username,
		"-d", db,
		"-f", inputPath,
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+conn.Password)
	cmd.Stderr = os.Stderr

	log.Info().
		Str("host", conn.Host).
		Int("port", port).
		Str("db", db).
		Str("input", inputPath).
		Msg("starting PostgreSQL restore")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("psql restore failed: %w", err)
	}
	return nil
}
