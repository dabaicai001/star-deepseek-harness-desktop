package adapters

import (
	"encoding/csv"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/rs/zerolog/log"
)

const csvSheetName = "CSV"

// CsvConnInfo CSV 连接参数
type CsvConnInfo struct {
	FilePath  string `json:"filePath"`
	Delimiter string `json:"delimiter,omitempty"`
}

// CsvAdapter 封装 CSV 文件操作
type CsvAdapter struct {
	rows      [][]string
	columns   []string
	filePath  string
	delimiter rune
}

// NewCsvAdapter 创建 CSV 适配器
func NewCsvAdapter(info *CsvConnInfo) (*CsvAdapter, error) {
	delimiter := csvDelimiter(info.Delimiter)
	if info.FilePath == "" {
		return &CsvAdapter{delimiter: delimiter}, nil
	}

	// 检查文件是否存在
	if _, err := os.Stat(info.FilePath); os.IsNotExist(err) {
		return &CsvAdapter{filePath: info.FilePath, delimiter: delimiter}, nil
	}

	f, err := os.Open(info.FilePath)
	if err != nil {
		return nil, fmt.Errorf("csv open failed: %w", err)
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1

	reader.Comma = delimiter

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
		rows:      allRows,
		columns:   columns,
		filePath:  info.FilePath,
		delimiter: delimiter,
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
	maxCols := maxColumnCount(a.rows)
	if maxCols == 0 {
		maxCols = 10
	}
	columns := make([]string, maxCols)
	copy(columns, a.columns)
	return columns
}

// GetSheetNames 返回 CSV 的虚拟单 Sheet 名称
func (a *CsvAdapter) GetSheetNames() []string {
	return []string{csvSheetName}
}

// ReadSheet 以工作表模型读取 CSV,第 1 行作为表头。
func (a *CsvAdapter) ReadSheet(sheetName string, offset, limit int) (*SheetData, error) {
	if sheetName != "" && sheetName != csvSheetName {
		return nil, fmt.Errorf("csv only supports virtual sheet %q", csvSheetName)
	}

	maxCols := maxColumnCount(a.rows)
	if maxCols == 0 {
		maxCols = 10
	}
	columns := make([]string, maxCols)
	if len(a.rows) > 0 {
		copy(columns, a.rows[0])
	}

	dataRowsAll := [][]string{}
	if len(a.rows) > 1 {
		for _, row := range a.rows[1:] {
			normalized := make([]string, maxCols)
			copy(normalized, row)
			dataRowsAll = append(dataRowsAll, normalized)
		}
	}

	start := offset
	if start < 0 {
		start = 0
	}
	if start >= len(dataRowsAll) {
		return &SheetData{
			SheetName: csvSheetName,
			Columns:   columns,
			Rows:      [][]string{},
			TotalRows: len(dataRowsAll),
		}, nil
	}

	end := len(dataRowsAll)
	if limit > 0 {
		end = start + limit
		if end > len(dataRowsAll) {
			end = len(dataRowsAll)
		}
	}
	return &SheetData{
		SheetName: csvSheetName,
		Columns:   columns,
		Rows:      dataRowsAll[start:end],
		TotalRows: len(dataRowsAll),
	}, nil
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
	if len(a.rows) == 0 {
		return 0
	}
	return len(a.rows) - 1
}

// GetFilePath 获取文件路径
func (a *CsvAdapter) GetFilePath() string {
	return a.filePath
}

// WriteCells 批量写入 CSV 数据区单元格
func (a *CsvAdapter) WriteCells(cells []CellChange) error {
	for _, cell := range cells {
		if cell.Row < 0 || cell.Col < 0 {
			return fmt.Errorf("invalid csv cell row=%d col=%d", cell.Row, cell.Col)
		}
		rawRow := cell.Row + 1
		a.ensureCell(rawRow, cell.Col)
		a.rows[rawRow][cell.Col] = cell.Value
	}
	a.syncColumns()
	return nil
}

// InsertRows 在数据区插入行
func (a *CsvAdapter) InsertRows(dataRow, count int) error {
	if count < 1 {
		count = 1
	}
	a.ensureHeader()
	target := dataRow + 1
	if target < 1 {
		target = 1
	}
	if target > len(a.rows) {
		target = len(a.rows)
	}
	width := maxColumnCount(a.rows)
	if width == 0 {
		width = 10
	}
	inserted := make([][]string, count)
	for i := range inserted {
		inserted[i] = make([]string, width)
	}
	a.rows = append(a.rows[:target], append(inserted, a.rows[target:]...)...)
	a.syncColumns()
	return nil
}

// DeleteRows 删除数据区行
func (a *CsvAdapter) DeleteRows(dataRow, count int) error {
	if count < 1 {
		count = 1
	}
	target := dataRow + 1
	if target < 1 || target >= len(a.rows) {
		return nil
	}
	end := target + count
	if end > len(a.rows) {
		end = len(a.rows)
	}
	a.rows = append(a.rows[:target], a.rows[end:]...)
	a.syncColumns()
	return nil
}

// InsertCols 插入列
func (a *CsvAdapter) InsertCols(col, count int) error {
	if count < 1 {
		count = 1
	}
	if col < 0 {
		col = 0
	}
	a.ensureHeader()
	for ri := range a.rows {
		for len(a.rows[ri]) < col {
			a.rows[ri] = append(a.rows[ri], "")
		}
		blank := make([]string, count)
		a.rows[ri] = append(a.rows[ri][:col], append(blank, a.rows[ri][col:]...)...)
	}
	a.syncColumns()
	return nil
}

// DeleteCols 删除列
func (a *CsvAdapter) DeleteCols(col, count int) error {
	if count < 1 {
		count = 1
	}
	if col < 0 {
		return nil
	}
	for ri := range a.rows {
		if col >= len(a.rows[ri]) {
			continue
		}
		end := col + count
		if end > len(a.rows[ri]) {
			end = len(a.rows[ri])
		}
		a.rows[ri] = append(a.rows[ri][:col], a.rows[ri][end:]...)
	}
	a.syncColumns()
	return nil
}

// SortRows 按数据列排序
func (a *CsvAdapter) SortRows(col int, descending bool) error {
	if len(a.rows) <= 2 {
		return nil
	}
	data := a.rows[1:]
	sort.SliceStable(data, func(i, j int) bool {
		left := cellValueAt(data[i], col)
		right := cellValueAt(data[j], col)
		cmp := compareSheetValues(left, right)
		if descending {
			return cmp > 0
		}
		return cmp < 0
	})
	a.syncColumns()
	return nil
}

// FindReplace 在 CSV 全文件中查找替换
func (a *CsvAdapter) FindReplace(opts FindReplaceOptions) (int, error) {
	if opts.Find == "" {
		return 0, fmt.Errorf("find text is required")
	}
	var re *regexp.Regexp
	var err error
	if opts.UseRegex {
		pattern := opts.Find
		if !opts.MatchCase {
			pattern = "(?i)" + pattern
		}
		re, err = regexp.Compile(pattern)
		if err != nil {
			return 0, fmt.Errorf("invalid regex: %w", err)
		}
	}
	replaced := 0
	for ri, row := range a.rows {
		for ci, value := range row {
			next, ok := replaceCellText(value, opts, re)
			if !ok {
				continue
			}
			a.rows[ri][ci] = next
			replaced++
		}
	}
	a.syncColumns()
	return replaced, nil
}

// RemoveDuplicates 删除重复数据行,保留第一条。
func (a *CsvAdapter) RemoveDuplicates(columns []int) (int, error) {
	if len(a.rows) <= 1 {
		return 0, nil
	}
	keyWidth := maxColumnCount(a.rows)
	seen := make(map[string]struct{})
	data := make([][]string, 0, len(a.rows)-1)
	removed := 0
	for _, row := range a.rows[1:] {
		key := buildDedupKey(row, columns, keyWidth)
		if _, ok := seen[key]; ok {
			removed++
			continue
		}
		seen[key] = struct{}{}
		data = append(data, row)
	}
	header := append([]string(nil), a.rows[0]...)
	a.rows = append([][]string{header}, data...)
	a.syncColumns()
	return removed, nil
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
	writer.Comma = a.delimiter
	defer writer.Flush()

	if err := writer.WriteAll(a.rows); err != nil {
		return fmt.Errorf("csv write failed: %w", err)
	}
	if err := writer.Error(); err != nil {
		return fmt.Errorf("csv flush failed: %w", err)
	}

	log.Info().Str("file", a.filePath).Int("rows", len(a.rows)).Msg("csv file saved")
	return nil
}

func (a *CsvAdapter) ensureHeader() {
	if len(a.rows) == 0 {
		a.rows = append(a.rows, make([]string, 10))
	}
}

func (a *CsvAdapter) ensureCell(row, col int) {
	a.ensureHeader()
	for len(a.rows) <= row {
		a.rows = append(a.rows, make([]string, maxColumnCount(a.rows)))
	}
	for len(a.rows[row]) <= col {
		a.rows[row] = append(a.rows[row], "")
	}
	if len(a.rows[0]) <= col {
		for len(a.rows[0]) <= col {
			a.rows[0] = append(a.rows[0], "")
		}
	}
}

func (a *CsvAdapter) syncColumns() {
	if len(a.rows) == 0 {
		a.columns = []string{}
		return
	}
	a.columns = append([]string(nil), a.rows[0]...)
}

func csvDelimiter(delimiter string) rune {
	if delimiter == "\t" || strings.EqualFold(delimiter, "tab") || strings.EqualFold(delimiter, "tsv") {
		return '\t'
	}
	return ','
}
