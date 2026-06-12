package adapters

import (
	"encoding/csv"
	"fmt"
	"os"

	"github.com/rs/zerolog/log"
)

// CsvConnInfo CSV 连接参数
type CsvConnInfo struct {
	FilePath  string `json:"filePath"`
	Delimiter string `json:"delimiter,omitempty"`
}

// CsvAdapter 封装 CSV 文件操作
type CsvAdapter struct {
	rows     [][]string
	columns  []string
	filePath string
}

// NewCsvAdapter 创建 CSV 适配器
func NewCsvAdapter(info *CsvConnInfo) (*CsvAdapter, error) {
	if info.FilePath == "" {
		return &CsvAdapter{}, nil
	}

	// 检查文件是否存在
	if _, err := os.Stat(info.FilePath); os.IsNotExist(err) {
		return &CsvAdapter{filePath: info.FilePath}, nil
	}

	f, err := os.Open(info.FilePath)
	if err != nil {
		return nil, fmt.Errorf("csv open failed: %w", err)
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.LazyQuotes = true

	if info.Delimiter == "\t" {
		reader.Comma = '\t'
	}
	if info.Delimiter == "," {
		reader.Comma = ','
	}

	allRows, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("csv read failed: %w", err)
	}

	columns := []string{}
	if len(allRows) > 0 {
		columns = allRows[0]
	}

	log.Info().Str("file", info.FilePath).Int("rows", len(allRows)).Msg("csv file opened")

	return &CsvAdapter{
		rows:     allRows,
		columns:  columns,
		filePath: info.FilePath,
	}, nil
}

// Close 关闭适配器
func (a *CsvAdapter) Close() error {
	return nil
}

// Ping 存活检测
func (a *CsvAdapter) Ping() error {
	return nil
}

// GetColumns 获取列名
func (a *CsvAdapter) GetColumns() []string {
	return a.columns
}

// GetRows 分页读取行
func (a *CsvAdapter) GetRows(offset, limit int) [][]string {
	start := offset
	if start >= len(a.rows) {
		return nil
	}
	end := len(a.rows)
	if limit > 0 {
		end = start + limit
		if end > len(a.rows) {
			end = len(a.rows)
		}
	}
	return a.rows[start:end]
}

// TotalRows 总行数
func (a *CsvAdapter) TotalRows() int {
	return len(a.rows)
}

// Save 保存 CSV
func (a *CsvAdapter) Save() error {
	if a.filePath == "" {
		return fmt.Errorf("no file path specified")
	}

	f, err := os.Create(a.filePath)
	if err != nil {
		return fmt.Errorf("csv create failed: %w", err)
	}
	defer f.Close()

	writer := csv.NewWriter(f)
	defer writer.Flush()

	if err := writer.WriteAll(a.rows); err != nil {
		return fmt.Errorf("csv write failed: %w", err)
	}

	log.Info().Str("file", a.filePath).Int("rows", len(a.rows)).Msg("csv file saved")
	return nil
}
