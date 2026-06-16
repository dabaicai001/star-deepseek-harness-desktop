package adapters

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

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

// FindReplaceOptions 查找替换选项
type FindReplaceOptions struct {
	Find       string `json:"find"`
	Replace    string `json:"replace"`
	MatchCase  bool   `json:"matchCase,omitempty"`
	EntireCell bool   `json:"entireCell,omitempty"`
	UseRegex   bool   `json:"useRegex,omitempty"`
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
	maxCols := maxColumnCount(rows)
	if maxCols == 0 {
		maxCols = 10
	}

	columns := make([]string, maxCols)
	if rawTotal > 0 {
		copy(columns, rows[0])
	}

	// 数据行 = 去掉标题行
	dataRowsAll := [][]string{}
	if rawTotal > 1 {
		for ri, row := range rows[1:] {
			normalized := make([]string, maxCols)
			copy(normalized, row)
			for ci := 0; ci < maxCols; ci++ {
				axis, _ := excelize.CoordinatesToCellName(ci+1, ri+2)
				formula, err := a.f.GetCellFormula(sheetName, axis)
				if err == nil && formula != "" {
					normalized[ci] = "=" + formula
				}
			}
			dataRowsAll = append(dataRowsAll, normalized)
		}
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
		axis, err := dataCellName(cell.Row, cell.Col)
		if err != nil {
			return err
		}
		value := strings.TrimSpace(cell.Value)
		if strings.HasPrefix(value, "=") && len(value) > 1 {
			if err := a.f.SetCellFormula(sheetName, axis, value[1:]); err != nil {
				return fmt.Errorf("write formula %s failed: %w", axis, err)
			}
			continue
		}
		if err := a.f.SetCellFormula(sheetName, axis, ""); err != nil {
			return fmt.Errorf("clear formula %s failed: %w", axis, err)
		}
		if err := a.f.SetCellValue(sheetName, axis, cell.Value); err != nil {
			return fmt.Errorf("write cell %s failed: %w", axis, err)
		}
	}
	return nil
}

// InsertRows 在数据区插入行,dataRow 为 0-based 数据行索引(表头下面第一行为 0)。
func (a *ExcelAdapter) InsertRows(sheetName string, dataRow, count int) error {
	if count < 1 {
		count = 1
	}
	targetRow := dataRow + 2
	if targetRow < 2 {
		targetRow = 2
	}
	if err := a.f.InsertRows(sheetName, targetRow, count); err != nil {
		return fmt.Errorf("insert rows failed: %w", err)
	}
	return nil
}

// DeleteRows 删除数据区行,不会删除第 1 行表头。
func (a *ExcelAdapter) DeleteRows(sheetName string, dataRow, count int) error {
	if count < 1 {
		count = 1
	}
	targetRow := dataRow + 2
	if targetRow < 2 {
		targetRow = 2
	}
	for i := 0; i < count; i++ {
		if err := a.f.RemoveRow(sheetName, targetRow); err != nil {
			return fmt.Errorf("delete row %d failed: %w", targetRow, err)
		}
	}
	return nil
}

// InsertCols 在指定列前插入列,会同步移动表头和数据。
func (a *ExcelAdapter) InsertCols(sheetName string, col, count int) error {
	if count < 1 {
		count = 1
	}
	colName, err := excelize.ColumnNumberToName(col + 1)
	if err != nil {
		return fmt.Errorf("invalid column %d: %w", col, err)
	}
	if err := a.f.InsertCols(sheetName, colName, count); err != nil {
		return fmt.Errorf("insert columns failed: %w", err)
	}
	return nil
}

// DeleteCols 删除指定列。
func (a *ExcelAdapter) DeleteCols(sheetName string, col, count int) error {
	if count < 1 {
		count = 1
	}
	for i := 0; i < count; i++ {
		colName, err := excelize.ColumnNumberToName(col + 1)
		if err != nil {
			return fmt.Errorf("invalid column %d: %w", col, err)
		}
		if err := a.f.RemoveCol(sheetName, colName); err != nil {
			return fmt.Errorf("delete column %s failed: %w", colName, err)
		}
	}
	return nil
}

// SortRows 按指定数据列排序,第 1 行表头保持不动。
func (a *ExcelAdapter) SortRows(sheetName string, col int, descending bool) error {
	rows, err := a.f.GetRows(sheetName)
	if err != nil {
		return fmt.Errorf("read sheet failed: %w", err)
	}
	if len(rows) <= 2 {
		return nil
	}

	header := append([]string(nil), rows[0]...)
	data := make([][]string, 0, len(rows)-1)
	for _, row := range rows[1:] {
		data = append(data, append([]string(nil), row...))
	}
	sort.SliceStable(data, func(i, j int) bool {
		left := cellValueAt(data[i], col)
		right := cellValueAt(data[j], col)
		less := compareSheetValues(left, right) < 0
		if descending {
			return !less && compareSheetValues(left, right) != 0
		}
		return less
	})

	if err := a.rewriteSheet(sheetName, header, data); err != nil {
		return err
	}
	return nil
}

// FindReplace 在整个工作表中查找并替换文本。
func (a *ExcelAdapter) FindReplace(sheetName string, opts FindReplaceOptions) (int, error) {
	if opts.Find == "" {
		return 0, fmt.Errorf("find text is required")
	}
	rows, err := a.f.GetRows(sheetName)
	if err != nil {
		return 0, fmt.Errorf("read sheet failed: %w", err)
	}

	var re *regexp.Regexp
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
	for ri, row := range rows {
		for ci, value := range row {
			next, ok := replaceCellText(value, opts, re)
			if !ok {
				continue
			}
			axis, _ := excelize.CoordinatesToCellName(ci+1, ri+1)
			if err := a.f.SetCellValue(sheetName, axis, next); err != nil {
				return replaced, fmt.Errorf("replace cell %s failed: %w", axis, err)
			}
			replaced++
		}
	}
	return replaced, nil
}

// SetFreezePanes 设置冻结窗格。rows/cols 为需要冻结的行列数量。
func (a *ExcelAdapter) SetFreezePanes(sheetName string, rows, cols int) error {
	if rows < 0 {
		rows = 0
	}
	if cols < 0 {
		cols = 0
	}
	if rows == 0 && cols == 0 {
		return a.f.SetPanes(sheetName, &excelize.Panes{Freeze: false, Split: false})
	}
	leftCol, _ := excelize.ColumnNumberToName(cols + 1)
	topLeftCell := fmt.Sprintf("%s%d", leftCol, rows+1)
	activePane := "bottomRight"
	if rows > 0 && cols == 0 {
		activePane = "bottomLeft"
	} else if rows == 0 && cols > 0 {
		activePane = "topRight"
	}
	return a.f.SetPanes(sheetName, &excelize.Panes{
		Freeze:      true,
		Split:       false,
		XSplit:      cols,
		YSplit:      rows,
		TopLeftCell: topLeftCell,
		ActivePane:  activePane,
		Selection: []excelize.Selection{
			{SQRef: topLeftCell, ActiveCell: topLeftCell, Pane: activePane},
		},
	})
}

// SetAutoFilter 开启当前已用区域的自动筛选。
func (a *ExcelAdapter) SetAutoFilter(sheetName string) error {
	dimension, err := a.f.GetSheetDimension(sheetName)
	if err != nil {
		return fmt.Errorf("get sheet dimension failed: %w", err)
	}
	if dimension == "" || dimension == "A1" {
		return nil
	}
	if err := a.f.AutoFilter(sheetName, dimension, []excelize.AutoFilterOptions{}); err != nil {
		return fmt.Errorf("set auto filter failed: %w", err)
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
	_ = a.f.UpdateLinkedValue()
	if err := a.f.SaveAs(a.filePath); err != nil {
		return fmt.Errorf("save failed: %w", err)
	}
	log.Info().Str("file", a.filePath).Msg("excel file saved")
	return nil
}

// SaveAs 另存为
func (a *ExcelAdapter) SaveAs(filePath string) error {
	_ = a.f.UpdateLinkedValue()
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
	keyWidth := maxColumnCount(rows)
	seen := make(map[string]int)

	removeRows := make([]bool, len(rows))
	for i := 1; i < len(rows); i++ {
		key := buildDedupKey(rows[i], columns, keyWidth)
		if firstIdx, exists := seen[key]; exists {
			removeRows[i] = true
			_ = firstIdx
		} else {
			seen[key] = i
		}
	}

	data := make([][]string, 0, len(rows)-1)
	for i := 1; i < len(rows); i++ {
		if !removeRows[i] {
			data = append(data, rows[i])
		}
	}

	if err := a.rewriteSheet(sheetName, header, data); err != nil {
		return 0, err
	}

	removed := len(rows) - 1 - len(data)
	return removed, nil
}

func buildDedupKey(row []string, columns []int, width int) string {
	var b strings.Builder
	if len(columns) == 0 {
		for col := 0; col < width; col++ {
			b.WriteString(cellValueAt(row, col))
			b.WriteByte(0)
		}
		return b.String()
	}
	for _, col := range columns {
		b.WriteString(cellValueAt(row, col))
		b.WriteByte(0)
	}
	return b.String()
}

func maxColumnCount(rows [][]string) int {
	maxCols := 0
	for _, row := range rows {
		if len(row) > maxCols {
			maxCols = len(row)
		}
	}
	return maxCols
}

func dataCellName(dataRow, col int) (string, error) {
	if dataRow < 0 {
		return "", fmt.Errorf("invalid row %d", dataRow)
	}
	if col < 0 {
		return "", fmt.Errorf("invalid column %d", col)
	}
	axis, err := excelize.CoordinatesToCellName(col+1, dataRow+2)
	if err != nil {
		return "", fmt.Errorf("invalid cell row=%d col=%d: %w", dataRow, col, err)
	}
	return axis, nil
}

func cellValueAt(row []string, col int) string {
	if col < 0 || col >= len(row) {
		return ""
	}
	return row[col]
}

func compareSheetValues(left, right string) int {
	leftNum, leftErr := strconv.ParseFloat(strings.TrimSpace(left), 64)
	rightNum, rightErr := strconv.ParseFloat(strings.TrimSpace(right), 64)
	if leftErr == nil && rightErr == nil {
		if leftNum < rightNum {
			return -1
		}
		if leftNum > rightNum {
			return 1
		}
		return 0
	}
	return strings.Compare(strings.ToLower(left), strings.ToLower(right))
}

func replaceCellText(value string, opts FindReplaceOptions, re *regexp.Regexp) (string, bool) {
	if opts.UseRegex && re != nil {
		if opts.EntireCell && !re.MatchString(value) {
			return value, false
		}
		if opts.EntireCell && re.FindString(value) != value {
			return value, false
		}
		next := re.ReplaceAllString(value, opts.Replace)
		return next, next != value
	}

	haystack := value
	needle := opts.Find
	if !opts.MatchCase {
		haystack = strings.ToLower(haystack)
		needle = strings.ToLower(needle)
	}
	if opts.EntireCell {
		if haystack != needle {
			return value, false
		}
		return opts.Replace, true
	}
	if !strings.Contains(haystack, needle) {
		return value, false
	}
	if opts.MatchCase {
		return strings.ReplaceAll(value, opts.Find, opts.Replace), true
	}
	return replaceAllFold(value, opts.Find, opts.Replace), true
}

func replaceAllFold(value, find, replace string) string {
	if find == "" {
		return value
	}
	lowerValue := strings.ToLower(value)
	lowerFind := strings.ToLower(find)
	var b strings.Builder
	start := 0
	for {
		idx := strings.Index(lowerValue[start:], lowerFind)
		if idx < 0 {
			b.WriteString(value[start:])
			break
		}
		idx += start
		b.WriteString(value[start:idx])
		b.WriteString(replace)
		start = idx + len(find)
	}
	return b.String()
}

func (a *ExcelAdapter) rewriteSheet(sheetName string, header []string, data [][]string) error {
	maxCols := len(header)
	for _, row := range data {
		if len(row) > maxCols {
			maxCols = len(row)
		}
	}
	if maxCols == 0 {
		maxCols = 1
	}

	oldRows, err := a.f.GetRows(sheetName)
	if err != nil {
		return fmt.Errorf("read sheet failed: %w", err)
	}
	oldMaxCols := maxColumnCount(oldRows)
	if oldMaxCols > maxCols {
		maxCols = oldMaxCols
	}
	for ri := 1; ri <= len(oldRows); ri++ {
		for ci := 1; ci <= maxCols; ci++ {
			axis, _ := excelize.CoordinatesToCellName(ci, ri)
			_ = a.f.SetCellValue(sheetName, axis, "")
		}
	}

	if len(header) > 0 {
		if err := a.f.SetSheetRow(sheetName, "A1", &header); err != nil {
			return fmt.Errorf("rewrite header failed: %w", err)
		}
	}
	for ri, row := range data {
		axis, _ := excelize.CoordinatesToCellName(1, ri+2)
		if err := a.f.SetSheetRow(sheetName, axis, &row); err != nil {
			return fmt.Errorf("rewrite row failed: %w", err)
		}
	}
	return nil
}
