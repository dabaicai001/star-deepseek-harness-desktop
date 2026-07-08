package adapters

import (
	"strconv"
	"testing"
)

func TestExcelWriteCellsWritesDataRowsBelowHeader(t *testing.T) {
	adapter, err := NewExcelAdapter(&ExcelConnInfo{})
	if err != nil {
		t.Fatalf("NewExcelAdapter failed: %v", err)
	}
	defer adapter.Close()

	if err := adapter.f.SetCellValue("Sheet1", "A1", "name"); err != nil {
		t.Fatalf("set header failed: %v", err)
	}
	if err := adapter.WriteCells("Sheet1", []CellChange{{Row: 0, Col: 0, Value: "alice"}}); err != nil {
		t.Fatalf("WriteCells failed: %v", err)
	}

	header, _ := adapter.f.GetCellValue("Sheet1", "A1")
	data, _ := adapter.f.GetCellValue("Sheet1", "A2")
	if header != "name" {
		t.Fatalf("header overwritten: got %q", header)
	}
	if data != "alice" {
		t.Fatalf("data cell mismatch: got %q", data)
	}
}

func TestExcelReadSheetKeepsFormulaText(t *testing.T) {
	adapter, err := NewExcelAdapter(&ExcelConnInfo{})
	if err != nil {
		t.Fatalf("NewExcelAdapter failed: %v", err)
	}
	defer adapter.Close()

	if err := adapter.f.SetCellValue("Sheet1", "A1", "total"); err != nil {
		t.Fatalf("set header failed: %v", err)
	}
	if err := adapter.WriteCells("Sheet1", []CellChange{{Row: 0, Col: 0, Value: "=SUM(B2:C2)"}}); err != nil {
		t.Fatalf("WriteCells failed: %v", err)
	}

	data, err := adapter.ReadSheet("Sheet1", 0, 0)
	if err != nil {
		t.Fatalf("ReadSheet failed: %v", err)
	}
	if len(data.Rows) != 1 || data.Rows[0][0] != "=SUM(B2:C2)" {
		t.Fatalf("formula was not preserved in grid data: %#v", data.Rows)
	}
}

func TestExcelInsertDeleteRowsAndColumns(t *testing.T) {
	adapter, err := NewExcelAdapter(&ExcelConnInfo{})
	if err != nil {
		t.Fatalf("NewExcelAdapter failed: %v", err)
	}
	defer adapter.Close()

	_ = adapter.f.SetCellValue("Sheet1", "A1", "name")
	_ = adapter.f.SetCellValue("Sheet1", "B1", "score")
	_ = adapter.f.SetCellValue("Sheet1", "A2", "alice")
	_ = adapter.f.SetCellValue("Sheet1", "B2", "9")

	if err := adapter.InsertRows("Sheet1", 0, 1); err != nil {
		t.Fatalf("InsertRows failed: %v", err)
	}
	if value, _ := adapter.f.GetCellValue("Sheet1", "A3"); value != "alice" {
		t.Fatalf("row was not shifted down: got %q", value)
	}
	if err := adapter.DeleteRows("Sheet1", 0, 1); err != nil {
		t.Fatalf("DeleteRows failed: %v", err)
	}
	if value, _ := adapter.f.GetCellValue("Sheet1", "A2"); value != "alice" {
		t.Fatalf("row was not restored: got %q", value)
	}

	if err := adapter.InsertCols("Sheet1", 1, 1); err != nil {
		t.Fatalf("InsertCols failed: %v", err)
	}
	if value, _ := adapter.f.GetCellValue("Sheet1", "C1"); value != "score" {
		t.Fatalf("column was not shifted right: got %q", value)
	}
	if err := adapter.DeleteCols("Sheet1", 1, 1); err != nil {
		t.Fatalf("DeleteCols failed: %v", err)
	}
	if value, _ := adapter.f.GetCellValue("Sheet1", "B1"); value != "score" {
		t.Fatalf("column was not restored: got %q", value)
	}
}

func TestExcelFindReplaceAndSortRows(t *testing.T) {
	adapter, err := NewExcelAdapter(&ExcelConnInfo{})
	if err != nil {
		t.Fatalf("NewExcelAdapter failed: %v", err)
	}
	defer adapter.Close()

	_ = adapter.f.SetCellValue("Sheet1", "A1", "name")
	_ = adapter.f.SetCellValue("Sheet1", "B1", "score")
	_ = adapter.f.SetCellValue("Sheet1", "A2", "bob")
	_ = adapter.f.SetCellValue("Sheet1", "B2", "2")
	_ = adapter.f.SetCellValue("Sheet1", "A3", "alice")
	_ = adapter.f.SetCellValue("Sheet1", "B3", "10")

	replaced, err := adapter.FindReplace("Sheet1", FindReplaceOptions{Find: "bob", Replace: "bobby"})
	if err != nil {
		t.Fatalf("FindReplace failed: %v", err)
	}
	if replaced != 1 {
		t.Fatalf("replace count mismatch: got %d", replaced)
	}
	if value, _ := adapter.f.GetCellValue("Sheet1", "A2"); value != "bobby" {
		t.Fatalf("replace value mismatch: got %q", value)
	}

	if err := adapter.SortRows("Sheet1", 1, true); err != nil {
		t.Fatalf("SortRows failed: %v", err)
	}
	if value, _ := adapter.f.GetCellValue("Sheet1", "A2"); value != "alice" {
		t.Fatalf("numeric descending sort mismatch: got %q", value)
	}
}

func TestDedupKeyTreatsMissingTrailingCellsAsBlank(t *testing.T) {
	left := buildDedupKey([]string{"alice"}, nil, 2)
	right := buildDedupKey([]string{"alice", ""}, nil, 2)
	if left != right {
		t.Fatalf("missing trailing blank should match explicit blank")
	}

	left = buildDedupKey([]string{"alice"}, []int{0, 1}, 2)
	right = buildDedupKey([]string{"alice", ""}, []int{0, 1}, 2)
	if left != right {
		t.Fatalf("selected missing trailing blank should match explicit blank")
	}
}

// TestReadSheetTrimsTrailingBlankRows 验证 ReadSheet 会裁掉数据区尾部所有空白行,
// 否则前端会拿到一堆无数据的 row,导致 Excel 视图出现大块留白。
func TestReadSheetTrimsTrailingBlankRows(t *testing.T) {
	adapter, err := NewExcelAdapter(&ExcelConnInfo{})
	if err != nil {
		t.Fatalf("NewExcelAdapter failed: %v", err)
	}
	defer adapter.Close()

	if err := adapter.f.SetCellValue("Sheet1", "A1", "id"); err != nil {
		t.Fatalf("set header failed: %v", err)
	}
	if err := adapter.f.SetCellValue("Sheet1", "B1", "title"); err != nil {
		t.Fatalf("set header failed: %v", err)
	}
	for ri, val := range []string{"10054", "10055", "10056"} {
		if err := adapter.f.SetCellValue("Sheet1", "A"+itoa(ri+2), val); err != nil {
			t.Fatalf("set data failed: %v", err)
		}
		if err := adapter.f.SetCellValue("Sheet1", "B"+itoa(ri+2), "row-"+itoa(ri)); err != nil {
			t.Fatalf("set data failed: %v", err)
		}
	}
	// 模拟"曾经编辑过但被清空"的尾部行:这些行 GetRows 会返回,但 ReadSheet 应裁掉。
	for ri := 5; ri <= 100; ri++ {
		if err := adapter.f.SetCellValue("Sheet1", "A"+itoa(ri), ""); err != nil {
			t.Fatalf("seed blank row failed: %v", err)
		}
		if err := adapter.f.SetCellValue("Sheet1", "B"+itoa(ri), " "); err != nil {
			t.Fatalf("seed blank row failed: %v", err)
		}
	}

	data, err := adapter.ReadSheet("Sheet1", 0, 0)
	if err != nil {
		t.Fatalf("ReadSheet failed: %v", err)
	}
	if data.TotalRows != 3 {
		t.Fatalf("TotalRows mismatch: want 3 (data only), got %d", data.TotalRows)
	}
	if len(data.Rows) != 3 {
		t.Fatalf("Rows length mismatch: want 3, got %d (rows=%#v)", len(data.Rows), data.Rows)
	}
}

func itoa(i int) string {
	return strconv.Itoa(i)
}
