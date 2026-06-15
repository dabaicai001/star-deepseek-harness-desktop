package adapters

import (
	"fmt"
	"os"

	"github.com/rs/zerolog/log"
	"github.com/xuri/excelize/v2"
)

// ExcelConnInfo Excel 连接参数
type ExcelConnInfo struct {
	FilePath string `json:"filePath"`
	Format   string `json:"format,omitempty"`
}

// ExcelAdapter 封装 Excel 文件操作
type ExcelAdapter struct {
	f        *excelize.File
	filePath string
}

// CellChange 单元格修改
type CellChange struct {
	Row   int    `json:"row"`
	Col   int    `json:"col"`
	Value string `json:"value"`
}

// SheetData 返回的 Sheet 数据
type SheetData struct {
	SheetName string     `json:"sheetName"`
	Columns   []string   `json:"columns"`
	Rows      [][]string `json:"rows"`
	TotalRows int        `json:"totalRows"`
}

// NewExcelAdapter 创建 Excel 适配器（打开现有文件或新建）
func NewExcelAdapter(info *ExcelConnInfo) (*ExcelAdapter, error) {
	if info.FilePath == "" {
		// 新建空白工作簿
		f := excelize.NewFile()
		return &ExcelAdapter{f: f}, nil
	}

	// 检查文件是否存在
	if _, err := os.Stat(info.FilePath); os.IsNotExist(err) {
		// 文件不存在,创建空白工作簿
		f := excelize.NewFile()
		return &ExcelAdapter{f: f, filePath: info.FilePath}, nil
	}

	f, err := excelize.OpenFile(info.FilePath)
	if err != nil {
		return nil, fmt.Errorf("excel open failed: %w", err)
	}

	log.Info().Str("file", info.FilePath).Msg("excel file opened")
	return &ExcelAdapter{f: f, filePath: info.FilePath}, nil
}

// Close 关闭适配器
func (a *ExcelAdapter) Close() error {
	if a.f != nil {
		if err := a.f.Close(); err != nil {
			return fmt.Errorf("excel close failed: %w", err)
		}
	}
	return nil
}

// Ping 存活检测
func (a *ExcelAdapter) Ping() error {
	if a.f == nil {
		return fmt.Errorf("excel adapter not initialized")
	}
	return nil
}

// GetSheetNames 获取所有 Sheet 名称
func (a *ExcelAdapter) GetSheetNames() []string {
	return a.f.GetSheetList()
}

// ReadSheet 读取 Sheet 数据（分页）
// offset/limit 为 0 表示返回全部（offset 基于数据行，不含标题行）
func (a *ExcelAdapter) ReadSheet(sheetName string, offset, limit int) (*SheetData, error) {
	rows, err := a.f.GetRows(sheetName)
	if err != nil {
		return nil, fmt.Errorf("read sheet failed: %w", err)
	}

	rawTotal := len(rows)
	columns := []string{}
	if rawTotal > 0 {
		columns = rows[0]
	}

	// 数据行 = 去掉标题行
	dataRowsAll := [][]string{}
	if rawTotal > 1 {
		dataRowsAll = rows[1:]
	}
	totalDataRows := len(dataRowsAll)

	start := offset
	if start < 0 {
		start = 0
	}
	if start >= totalDataRows {
		return &SheetData{
			SheetName: sheetName,
			Columns:   columns,
			Rows:      [][]string{},
			TotalRows: totalDataRows,
		}, nil
	}
	end := totalDataRows
	if limit > 0 {
		end = start + limit
		if end > totalDataRows {
			end = totalDataRows
		}
	}

	return &SheetData{
		SheetName: sheetName,
		Columns:   columns,
		Rows:      dataRowsAll[start:end],
		TotalRows: totalDataRows,
	}, nil
}

// WriteCells 批量写入单元格
func (a *ExcelAdapter) WriteCells(sheetName string, cells []CellChange) error {
	for _, cell := range cells {
		colName, err := excelize.ColumnNumberToName(cell.Col + 1)
		if err != nil {
			return fmt.Errorf("invalid column %d: %w", cell.Col, err)
		}
		axis := fmt.Sprintf("%s%d", colName, cell.Row+1)
		if err := a.f.SetCellValue(sheetName, axis, cell.Value); err != nil {
			return fmt.Errorf("write cell %s failed: %w", axis, err)
		}
	}
	return nil
}

// AddSheet 添加 Sheet
func (a *ExcelAdapter) AddSheet(sheetName string) error {
	_, err := a.f.NewSheet(sheetName)
	return err
}

// RemoveSheet 删除 Sheet
func (a *ExcelAdapter) RemoveSheet(sheetName string) error {
	return a.f.DeleteSheet(sheetName)
}

// RenameSheet 重命名 Sheet
func (a *ExcelAdapter) RenameSheet(oldName, newName string) error {
	return a.f.SetSheetName(oldName, newName)
}

// Save 保存文件
func (a *ExcelAdapter) Save() error {
	if a.filePath == "" {
		return fmt.Errorf("no file path specified")
	}
	if err := a.f.SaveAs(a.filePath); err != nil {
		return fmt.Errorf("save failed: %w", err)
	}
	log.Info().Str("file", a.filePath).Msg("excel file saved")
	return nil
}

// SaveAs 另存为
func (a *ExcelAdapter) SaveAs(filePath string) error {
	if err := a.f.SaveAs(filePath); err != nil {
		return fmt.Errorf("save as failed: %w", err)
	}
	a.filePath = filePath
	log.Info().Str("file", filePath).Msg("excel file saved as")
	return nil
}

// GetFilePath 获取文件路径
func (a *ExcelAdapter) GetFilePath() string {
	return a.filePath
}

// RemoveDuplicates 删除重复行
// columns: 基于哪些列判断重复（0-based 列索引）
// 返回删除的行数
func (a *ExcelAdapter) RemoveDuplicates(sheetName string, columns []int) (int, error) {
	rows, err := a.f.GetRows(sheetName)
	if err != nil {
		return 0, fmt.Errorf("read sheet failed: %w", err)
	}

	if len(rows) <= 1 {
		return 0, nil
	}

	header := rows[0]
	seen := make(map[string]int)

	// 反向遍历,标记重复
	removeRows := make([]bool, len(rows))
	for i := 1; i < len(rows); i++ {
		key := buildDedupKey(rows[i], columns)
		if firstIdx, exists := seen[key]; exists {
			removeRows[i] = true
			_ = firstIdx
		} else {
			seen[key] = i
		}
	}

	// 清除 Sheet 数据,重新写入
	if err := a.f.SetSheetRow(sheetName, "A1", &header); err != nil {
		return 0, fmt.Errorf("rewrite header failed: %w", err)
	}

	writeIdx := 1
	removed := 0
	for i := 1; i < len(rows); i++ {
		if !removeRows[i] {
			writeIdx++
			axis, _ := excelize.CoordinatesToCellName(1, writeIdx)
			if err := a.f.SetSheetRow(sheetName, axis, &rows[i]); err != nil {
				return 0, fmt.Errorf("rewrite row failed: %w", err)
			}
		} else {
			removed++
		}
	}

	// 清除多余行
	totalRows := len(rows)
	for row := writeIdx + 1; row <= totalRows; row++ {
		for col := 0; col < len(header); col++ {
			axis, _ := excelize.CoordinatesToCellName(col+1, row)
			a.f.SetCellValue(sheetName, axis, "")
		}
	}

	return removed, nil
}

func buildDedupKey(row []string, columns []int) string {
	if len(columns) == 0 {
		// 默认所有列
		key := ""
		for _, v := range row {
			key += v + "\x00"
		}
		return key
	}
	key := ""
	for _, col := range columns {
		if col < len(row) {
			key += row[col] + "\x00"
		}
	}
	return key
}
